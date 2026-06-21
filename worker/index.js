/**
 * ShadowEcho — Cloudflare Worker v2
 *
 * Architecture:
 *   Chrome Extension → Bearer JWT (Supabase) → this Worker → DeepL / OpenRouter / Groq
 *
 * Worker Secrets (wrangler secret put):
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (sb_secret_...)
 *   DEEPL_API_KEY         DeepL auth key
 *   OPENROUTER_API_KEY    OpenRouter key
 *   ADMIN_KEY             admin API key for management endpoints
 *   GROQ_API_KEY_1..5     Groq Whisper keys (round-robin, fallback on 429)
 *   RESEND_API_KEY        (tuỳ chọn) Resend.com key để gửi email cảnh báo Groq hết quota
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
};

export const OR_MODELS = [
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

// Chỉ cho phép model trong whitelist (chống client gọi model tốn tiền).
export function allowedModel(model) {
  return OR_MODELS.includes(model) ? model : OR_MODELS[0];
}

// Parse Sentry DSN -> {key, host, projectId} hoặc null. (tách ra để test được)
export function parseSentryDsn(dsn) {
  const m = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn || '');
  if (!m) return null;
  return { key: m[1], host: m[2], projectId: m[3] };
}

// UUID v4-ish (Supabase user id) — chặn giá trị lạ chèn vào query PostgREST.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Main dispatcher ──────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Public health check
    if (url.pathname === '/health') {
      return json({ ok: true, version: '2.2.0', arch: 'supabase-jwt', features: ['ratelimit', 'error-log', 'log-ratelimit'] });
    }

    // Public error/telemetry sink (no auth) — giới hạn theo IP để chống lạm dụng.
    if (url.pathname === '/log') {
      if (env.RATE_LIMITER) {
        try {
          const ip = request.headers.get('CF-Connecting-IP') || 'anon';
          const { success } = await env.RATE_LIMITER.limit({ key: 'log:' + ip });
          if (!success) return json({ error: 'rate_limited' }, 429);
        } catch (_) { /* binding lỗi -> không chặn */ }
      }
      return handleLog(request, env);
    }

    // Admin endpoints (internal use only)
    if (url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, url.pathname, env);
    }

    // Public pronunciation scoring (rate-limited by IP, no auth required —
    // only receives the text transcript + target sentence, never raw audio).
    if (url.pathname === '/score-ai') {
      return handleScoreAI(request, env);
    }

    // Public STT transcription via Groq Whisper (rate-limited by IP, no auth).
    // Receives raw audio blob, returns transcript text. Never stores audio.
    if (url.pathname === '/transcribe') {
      return handleTranscribe(request, env, ctx);
    }

    // All other routes require Supabase JWT
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (!token) {
      return json({ error: 'missing_token', message: 'Please log in to use this service.' }, 401);
    }

    const user = await verifyToken(token, env);
    if (!user) {
      return json({ error: 'invalid_token', message: 'Session expired. Please log in again.' }, 401);
    }

    // Per-user burst rate limit (Cloudflare native, GA). Chống spam theo giây.
    // Quota theo NGÀY vẫn do Supabase RPC xử lý riêng.
    if (env.RATE_LIMITER && (url.pathname === '/translate' || url.pathname === '/ai-translate')) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: user.id });
        if (!success) {
          return json({ error: 'rate_limited', message: 'Bạn thao tác quá nhanh. Vui lòng chờ vài giây rồi thử lại.' }, 429);
        }
      } catch (_) { /* binding lỗi -> không chặn (fail-open chỉ cho burst limit) */ }
    }

    if (url.pathname === '/translate') {
      return handleDeepL(request, env, user.id);
    }

    if (url.pathname === '/ai-translate') {
      return handleOpenRouter(request, env, user.id);
    }

    if (url.pathname === '/me') {
      return handleMe(env, user);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ── /score-ai  — AI pronunciation scoring via OpenRouter (free) ──
// Public endpoint (rate-limited by IP). Receives text transcript + target
// sentence; never stores audio. Returns structured JSON score.
async function handleScoreAI(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Burst rate limit per IP (reuse same binding as /log).
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: 'score:' + ip });
      if (!success) return json({ error: 'rate_limited' }, 429);
    } catch (_) {}
  }

  if (!env.OPENROUTER_API_KEY && !env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { target, transcript, targetLang = 'de' } = body;
  if (!target || !transcript) return json({ error: 'missing_fields' }, 400);
  if (String(target).length > 400 || String(transcript).length > 400) return json({ error: 'too_long' }, 400);

  const LANG_NAME = { de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
  const langName = LANG_NAME[targetLang] || targetLang;
  const systemPrompt = `You are evaluating ${langName} pronunciation. Respond ONLY with a JSON object — no markdown, no explanation.`;
  const userPrompt = `Target: "${target}"\nStudent said: "${transcript}"\n\nReturn JSON only:\n{"pronunciation":0-100,"fluency":0-100,"overall":0-100,"feedback":"tip in Vietnamese ≤12 words"}`;

  // Primary: OpenRouter free models (try in order, 5s timeout each)
  if (env.OPENROUTER_API_KEY) {
    const SCORE_MODELS = [
      'google/gemma-4-31b-it:free',
      'openai/gpt-oss-120b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ];
    for (const model of SCORE_MODELS) {
      try {
        const resp = await Promise.race([
          fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://shadowecho.app',
              'X-Title': 'ShadowEcho Language Learning',
            },
            body: JSON.stringify({
              model,
              max_tokens: 150,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
            }),
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        if (!resp.ok) continue;
        const data = await resp.json();
        const raw = (data?.choices?.[0]?.message?.content || '').trim().replace(/^```json\n?|\n?```$/g, '').trim();
        if (!raw) continue;
        const score = JSON.parse(raw);
        if (!score.overall) continue;
        return json({ ...score, engine: 'openrouter/' + model.split('/')[0], transcript });
      } catch (_) { /* try next model */ }
    }
  }

  // Fallback: Anthropic Claude Haiku (if key configured)
  if (env.ANTHROPIC_API_KEY) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!resp.ok) return json({ error: 'anthropic-' + resp.status }, 502);
      const data = await resp.json();
      const raw = (data?.content?.[0]?.text || '').trim().replace(/^```json\n?|\n?```$/g, '').trim();
      const score = JSON.parse(raw);
      return json({ ...score, engine: 'claude-haiku', transcript });
    } catch (e) {
      return json({ error: 'score-error', message: e.message }, 500);
    }
  }

  return json({ error: 'all_models_failed' }, 503);
}

// ── /transcribe  — Groq Whisper STT proxy ───────────────────
// Public endpoint (rate-limited by IP). Receives audio blob (multipart/form-data),
// round-robins through 5 Groq API keys, emails alert if all exhausted.
export const GROQ_LANG_MAP = { de: 'de', en: 'en', fr: 'fr', es: 'es', it: 'it', ja: 'ja', ko: 'ko', zh: 'zh', pt: 'pt', ru: 'ru', ar: 'ar', nl: 'nl', pl: 'pl', sv: 'sv', tr: 'tr' };

async function sendAlertEmail(env, subject, body) {
  if (!env.RESEND_API_KEY) { console.error('[GROQ-ALERT]', subject); return; }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'NghienDe Alert <noreply@shadowecho.app>', to: ['cfvblue@gmail.com'], subject, text: body }),
    });
  } catch (e) { console.error('[ALERT-EMAIL-FAILED]', e.message); }
}

// Gửi email cảnh báo "hết Groq quota" nhưng CHỐNG TRÙNG: chỉ 1 lần mỗi 6 giờ
// (dùng KV làm cờ thời gian). Tránh spam hộp thư khi có nhiều request liên tục.
async function maybeAlertGroqExhausted(env, keyCount) {
  const ALERT_TTL = 6 * 60 * 60; // 6 giờ
  if (env.ALERT_KV) {
    try {
      const last = await env.ALERT_KV.get('groq_exhausted_alert');
      if (last) return; // đã gửi trong 6 giờ qua -> bỏ qua
      await env.ALERT_KV.put('groq_exhausted_alert', new Date().toISOString(), { expirationTtl: ALERT_TTL });
    } catch (_) { /* KV lỗi -> vẫn gửi (thà trùng còn hơn mất cảnh báo) */ }
  }
  await sendAlertEmail(env,
    'NghienDe: Tất cả Groq API keys đã hết quota',
    `Tất cả ${keyCount} Groq API keys đã hết hạn mức (429 Too Many Requests).\n\n` +
    `Hệ thống đã TỰ ĐỘNG chuyển sang phương án miễn phí (Whisper offline trên máy khách) — ` +
    `người dùng KHÔNG bị gián đoạn và không hề biết.\n\n` +
    `Bạn nên thêm keys mới hoặc nâng cấp tại https://console.groq.com\n\n` +
    `(Email này chỉ gửi 1 lần mỗi 6 giờ để tránh spam.)\n` +
    `Thời gian: ${new Date().toISOString()}`
  );
}

async function handleTranscribe(request, env, ctx) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: 'transcribe:' + ip });
      if (!success) return json({ error: 'rate_limited' }, 429);
    } catch (_) {}
  }

  let formData;
  try { formData = await request.formData(); } catch { return json({ error: 'bad_form' }, 400); }
  const file = formData.get('file');
  if (!file) return json({ error: 'missing_file' }, 400);
  const langCode = String(formData.get('lang') || 'de').toLowerCase().slice(0, 5);
  const lang = GROQ_LANG_MAP[langCode] || 'de';

  const GROQ_KEYS = [
    env.GROQ_API_KEY_1, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3,
    env.GROQ_API_KEY_4, env.GROQ_API_KEY_5,
  ].filter(Boolean);

  if (!GROQ_KEYS.length) return json({ error: 'groq_not_configured' }, 503);

  // Track whether every attempted key hit a quota limit (429) — if so, alert.
  let allQuota = true;
  for (const key of GROQ_KEYS) {
    try {
      const groqForm = new FormData();
      groqForm.append('file', file, 'recording.webm');
      groqForm.append('model', 'whisper-large-v3-turbo');
      groqForm.append('language', lang);
      groqForm.append('response_format', 'verbose_json');
      groqForm.append('timestamp_granularities[]', 'word');

      const resp = await Promise.race([
        fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}` },
          body: groqForm,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);

      if (resp.status === 429) continue; // quota exhausted on this key -> try next
      allQuota = false;
      if (!resp.ok) continue;
      const data = await resp.json();
      return json({ text: data.text || '', words: data.words || [], engine: 'groq-whisper' });
    } catch (_) { allQuota = false; } // timeout/network error: not a quota issue
  }

  // Hết cả 5 key (đều 429) -> gửi email cảnh báo ẩn (chống trùng, không chặn
  // người dùng nhờ waitUntil) rồi báo extension chuyển sang phương án miễn phí.
  if (allQuota) {
    const alert = maybeAlertGroqExhausted(env, GROQ_KEYS.length);
    if (ctx && ctx.waitUntil) ctx.waitUntil(alert); else await alert;
    return json({ error: 'groq_exhausted', fallback: 'free' }, 503);
  }

  return json({ error: 'groq_unavailable' }, 503);
}

// ── Supabase JWT verification ────────────────────────────────
async function verifyToken(token, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
      },
    });
    if (!res.ok) return null;
    return await res.json(); // { id, email, ... }
  } catch {
    return null;
  }
}

// ── Quota check + atomic increment via Supabase RPC ──────────
async function checkQuota(userId, type, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/check_and_increment_usage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: userId, p_type: type }),
    });
    if (!res.ok) {
      console.error('checkQuota RPC error', res.status);
      return { allowed: false, error: 'quota_service_unavailable' };
    }
    return await res.json();
  } catch (e) {
    console.error('checkQuota network error', e.message);
    return { allowed: false, error: 'quota_service_unavailable' };
  }
}

// ── /me  — return user profile + today's usage ───────────────
async function handleMe(env, user) {
  try {
    const [profileRes, usageRes] = await Promise.all([
      fetch(
        `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=plan,email,full_name`,
        {
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
          },
        }
      ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/usage?user_id=eq.${encodeURIComponent(user.id)}&date=eq.${today()}&select=translation_count,ai_count`,
        {
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
          },
        }
      ),
    ]);

    const profiles = profileRes.ok ? await profileRes.json() : [];
    const usages   = usageRes.ok   ? await usageRes.json()   : [];
    const profile  = profiles[0] || { plan: 'free', email: user.email };
    const planName = profile.plan || 'free'; // tránh ?name=eq.undefined
    const usage    = usages[0]   || { translation_count: 0, ai_count: 0 };

    // Get plan quotas
    const planRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/plans?name=eq.${encodeURIComponent(planName)}&select=daily_translations,daily_ai_calls,display_name`,
      {
        headers: {
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'apikey': env.SUPABASE_SERVICE_KEY,
        },
      }
    );
    const plans = planRes.ok ? await planRes.json() : [];
    const plan  = plans[0] || { daily_translations: 20, daily_ai_calls: 10, display_name: 'Free' };

    return json({
      email: profile.email || user.email,
      plan: planName,
      planName: plan.display_name,
      usage: {
        translations: { used: usage.translation_count, limit: plan.daily_translations },
        ai:           { used: usage.ai_count,          limit: plan.daily_ai_calls },
      },
    });
  } catch (e) {
    return json({ error: 'profile-error', message: e.message }, 500);
  }
}

// ── /translate  — DeepL proxy ────────────────────────────────
async function handleDeepL(request, env, userId) {
  const quota = await checkQuota(userId, 'translation', env);
  if (!quota.allowed) {
    return json({
      error: 'quota_exceeded',
      message: `Daily translation limit reached (${quota.used}/${quota.limit}). Upgrade your plan at shadowecho.app`,
      plan: quota.plan, used: quota.used, limit: quota.limit,
    }, 429);
  }

  try {
    const body = await request.json();
    const params = new URLSearchParams();
    params.append('text', body.text || '');
    params.append('target_lang', body.target_lang || 'VI');
    if (body.source_lang) params.append('source_lang', body.source_lang);

    const resp = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: `deepl-${resp.status}`, details: data }, resp.status);
    return json(data);
  } catch (e) {
    return json({ error: 'deepl-error', message: e.message }, 500);
  }
}

// ── /ai-translate  — OpenRouter proxy ───────────────────────
async function handleOpenRouter(request, env, userId) {
  const quota = await checkQuota(userId, 'ai', env);
  if (!quota.allowed) {
    return json({
      error: 'quota_exceeded',
      message: `Daily AI limit reached (${quota.used}/${quota.limit}). Upgrade your plan at shadowecho.app`,
      plan: quota.plan, used: quota.used, limit: quota.limit,
    }, 429);
  }

  try {
    const body = await request.json();
    // Ensure only allowed models
    const model = allowedModel(body.model);

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://shadowecho.app',
        'X-Title': 'ShadowEcho Language Learning',
      },
      body: JSON.stringify({ ...body, model }),
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: `openrouter-${resp.status}`, details: data }, resp.status);
    return json(data);
  } catch (e) {
    return json({ error: 'openrouter-error', message: e.message }, 500);
  }
}

// ── /admin/*  — Management API ────────────────────────────────
async function handleAdmin(request, pathname, env) {
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (adminKey !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 403);
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const body = await request.json();

  // POST /admin/upgrade  — upgrade a user's plan
  if (pathname === '/admin/upgrade') {
    const { user_id, plan, months } = body;
    if (!isUuid(user_id) || !plan) return json({ error: 'invalid user_id or missing plan' }, 400);

    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_set_plan`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: user_id, p_plan: plan, p_months: months || 12 }),
    });

    return res.ok ? json({ success: true }) : json({ error: 'supabase-error' }, 500);
  }

  // POST /admin/usage  — get a user's usage stats
  if (pathname === '/admin/usage') {
    const { user_id } = body;
    if (!isUuid(user_id)) return json({ error: 'invalid user_id' }, 400);

    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/usage?user_id=eq.${encodeURIComponent(user_id)}&order=date.desc&limit=30`,
      {
        headers: {
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'apikey': env.SUPABASE_SERVICE_KEY,
        },
      }
    );
    const data = res.ok ? await res.json() : [];
    return json({ usage: data });
  }

  return json({ error: 'unknown admin action' }, 400);
}

// ── /log  — error & telemetry sink ───────────────────────────
// Nhận lỗi từ extension. Nếu có SENTRY_DSN -> chuyển tiếp lên Sentry.
// Nếu chưa cấu hình Sentry -> ghi console (xem qua `wrangler tail`).
async function handleLog(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 16000) return json({ error: 'payload_too_large' }, 413); // chặn lạm dụng
    body = JSON.parse(raw);
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }

  const event = {
    level: body.level || 'error',
    message: String(body.message || '').slice(0, 2000),
    stack: String(body.stack || '').slice(0, 4000),
    context: body.context || {},
    where: String(body.where || 'unknown').slice(0, 100),
    version: String(body.version || ''),
    ts: new Date().toISOString(),
  };

  // Luôn ghi console (đủ để debug khi chưa gắn Sentry)
  console.error('[client-error]', event.where, event.message, event.stack);

  if (env.SENTRY_DSN) {
    try { await forwardToSentry(env.SENTRY_DSN, event); } catch (e) { console.error('sentry-forward-failed', e.message); }
  }
  return json({ ok: true });
}

// Đẩy 1 event lên Sentry qua HTTP store API (không cần SDK).
async function forwardToSentry(dsn, event) {
  // DSN dạng: https://<publicKey>@<host>/<projectId>
  const parsed = parseSentryDsn(dsn);
  if (!parsed) return;
  const { key, host, projectId } = parsed;
  const endpoint = `https://${host}/api/${projectId}/store/?sentry_key=${key}&sentry_version=7`;
  const payload = {
    platform: 'javascript',
    level: event.level,
    timestamp: event.ts,
    release: event.version || undefined,
    tags: { where: event.where },
    extra: event.context,
    exception: { values: [{ type: 'ClientError', value: event.message, stacktrace: { frames: [] } }] },
    message: event.message + (event.stack ? '\n' + event.stack : ''),
  };
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function today() {
  return new Date().toISOString().split('T')[0];
}
