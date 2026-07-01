/**
 * ShadowEcho — Cloudflare Worker v2
 *
 * Architecture:
 *   Chrome Extension → Bearer JWT (Supabase) → this Worker → DeepL / OpenRouter / Groq
 *
 * Worker Secrets (wrangler secret put):
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (sb_secret_...)
 *   DEEPL_API_KEY         DeepL auth key (fallback khi pool trống)
 *   OPENROUTER_API_KEY    OpenRouter key (fallback khi pool trống)
 *   GEMINI_API_KEY        Google AI Studio key cho dịch trả phí (fallback khi pool trống)
 *   MISTRAL_API_KEY       (tuỳ chọn) Mistral key (fallback khi pool trống)
 *   GEMINI_MODEL          (tuỳ chọn) model Gemini, mặc định 'gemini-2.0-flash'
 *   MISTRAL_MODEL         (tuỳ chọn) model Mistral, mặc định 'mistral-small-latest'
 *   ADMIN_KEY             admin API key for management endpoints
 *   GROQ_API_KEY_1..5     Groq Whisper keys (round-robin, fallback on 429)
 *   RESEND_API_KEY        (tuỳ chọn) Resend.com key để gửi email cảnh báo Groq hết quota
 *   ADMIN_JWT_SECRET      khoá ký JWT phiên admin (trang Admin SPA)
 *   KEY_ENCRYPTION_KEY    khoá AES-GCM mã hoá API key lưu trong DB (admin)
 *   SEPAY_WEBHOOK_KEY     khoá xác thực webhook SePay (thanh toán)
 */

import { handleAdminV2, handleSepayWebhook, scheduledAdmin, decryptSecret } from './admin.js';

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

    // Phục vụ trang Admin SPA (static) cho GET trên trình duyệt. API là POST (+ /health, /me GET).
    // Guard bằng env.ASSETS → nếu chưa bật binding thì hành vi như cũ (không đổi gì).
    if (env.ASSETS && request.method === 'GET' && url.pathname !== '/health' && url.pathname !== '/me') {
      return env.ASSETS.fetch(request);
    }

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

    // Admin endpoints (trang Admin SPA): /admin/login + /admin/bootstrap công khai,
    // các endpoint còn lại yêu cầu phiên JWT admin (xem worker/admin.js).
    if (url.pathname.startsWith('/admin/')) {
      return handleAdminV2(request, url.pathname, env, ctx);
    }

    // SePay webhook (công khai, xác thực bằng Apikey của SePay) → tự cập nhật thanh toán.
    if (url.pathname === '/sepay/webhook') {
      return handleSepayWebhook(request, env);
    }

    // Public pronunciation scoring (rate-limited by IP, no auth required —
    // only receives the text transcript + target sentence, never raw audio).
    if (url.pathname === '/score-ai') {
      return handleScoreAI(request, env, ctx);
    }

    // Public STT transcription via Groq Whisper (rate-limited by IP, no auth).
    // Receives raw audio blob, returns transcript text. Never stores audio.
    if (url.pathname === '/transcribe') {
      return handleTranscribe(request, env, ctx);
    }

    // Public payment info (no auth) — chỉ field công khai để extension hiện khi user nâng cấp Pro.
    // KHÔNG trả sepay key / bic nội bộ. Dùng POST để không bị cổng ASSETS (GET) nuốt.
    if (url.pathname === '/pay-info') {
      return handlePayInfo(env);
    }

    // Public: khách bấm Nâng cấp Pro → điền Họ tên/email/phương thức → tạo đơn + gửi email.
    if (url.pathname === '/upgrade-request') {
      if (env.RATE_LIMITER) {
        try { const ip = request.headers.get('CF-Connecting-IP') || 'anon'; const { success } = await env.RATE_LIMITER.limit({ key: 'upgrade:' + ip }); if (!success) return json({ error: 'rate_limited' }, 429); } catch (_) {}
      }
      return handleUpgradeRequest(request, env, ctx);
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

    // Chặn user bị cấm (Admin bấm "Cấm") — áp cho mọi route cần đăng nhập.
    if (await isBanned(env, user.id)) {
      return json({ error: 'banned', message: 'Tài khoản của bạn đã bị khoá. Vui lòng liên hệ quản trị.' }, 403);
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
      return handleTranslate(request, env, user.id, ctx);
    }

    if (url.pathname === '/ai-translate') {
      return handleOpenRouter(request, env, user.id);
    }

    if (url.pathname === '/me') {
      return handleMe(env, user);
    }

    if (url.pathname === '/session/ping') {
      return handleSessionPing(request, env, user, ctx);
    }

    // Đồng bộ từ vựng/câu đã lưu theo tài khoản (đăng nhập máy nào cũng có dữ liệu).
    if (url.pathname === '/sync') {
      return handleSync(request, env, user);
    }

    return json({ error: 'not_found' }, 404);
  },

  // Cron: reset hạn mức API key theo chu kỳ + dọn session admin hết hạn.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledAdmin(env));
  },
};

// Gọi 1 model chat (OpenAI-compatible) để chấm điểm. Trả { status, score, usage }.
async function scoreOnce(provider, model, key, systemPrompt, userPrompt) {
  const conf = {
    groq:       { url: 'https://api.groq.com/openai/v1/chat/completions', to: 4000, hdr: {} },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',   to: 8000, hdr: { 'HTTP-Referer': 'https://shadowecho.app', 'X-Title': 'ShadowEcho Language Learning' } },
    mistral:    { url: 'https://api.mistral.ai/v1/chat/completions',      to: 8000, hdr: {} },
  }[provider];
  if (!conf) return { status: 0, score: null };
  const resp = await Promise.race([
    fetch(conf.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...conf.hdr },
      body: JSON.stringify({ model, max_tokens: 150, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), conf.to)),
  ]);
  if (!resp.ok) return { status: resp.status, score: null };
  const data = await resp.json();
  const raw = (data?.choices?.[0]?.message?.content || '').trim().replace(/^```json\n?|\n?```$/g, '').trim();
  if (!raw) return { status: resp.status, score: null };
  let score; try { score = JSON.parse(raw); } catch (_) { return { status: resp.status, score: null }; }
  return { status: resp.status, score, usage: data.usage || null };
}

// ── /score-ai  — AI pronunciation scoring (model & key theo catalog, có fallback) ──
// Public endpoint (rate-limited by IP). Receives text transcript + target
// sentence; never stores audio. Returns structured JSON score.
async function handleScoreAI(request, env, ctx) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Nếu có token: chặn user local (dùng máy) + user bị cấm → KHÔNG tốn Groq.
  const gate = await publicUserGate(env, request);
  if (gate && gate.block) return gate.resp;
  // Free 60'/ngày (chỉ khi đăng nhập): hết giờ → chặn.
  if (gate && gate.user) { const q = await freeHourGate(env, gate.user.id); if (q) return q; }

  // Burst rate limit per IP (reuse same binding as /log).
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: 'score:' + ip });
      if (!success) return json({ error: 'rate_limited' }, 429);
    } catch (_) {}
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { target, transcript, targetLang = 'de', nativeLang = 'vi' } = body;
  if (!target || !transcript) return json({ error: 'missing_fields' }, 400);
  if (String(target).length > 400 || String(transcript).length > 400) return json({ error: 'too_long' }, 400);

  const LANG_NAME = { de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', vi: 'Vietnamese' };
  const langName = LANG_NAME[targetLang] || targetLang;
  const fbLangName = LANG_NAME[nativeLang] || 'Vietnamese';
  const systemPrompt = `You are evaluating ${langName} pronunciation. Respond ONLY with a JSON object — no markdown, no explanation.`;
  const userPrompt = `Target: "${target}"\nStudent said: "${transcript}"\n\nReturn JSON only:\n{"pronunciation":0-100,"fluency":0-100,"overall":0-100,"feedback":"tip in ${fbLangName} ≤12 words"}`;

  // Chuỗi model theo catalog (capability 'score'); trống → mặc định như cũ (Groq → OpenRouter).
  const route0 = await routeModels(env, 'score');
  const route = route0.length ? route0 : [
    { provider_id: 'groq', model_id: 'llama-3.3-70b-versatile' },
    { provider_id: 'groq', model_id: 'llama-3.1-8b-instant' },
    ...OR_MODELS.map((m) => ({ provider_id: 'openrouter', model_id: m })),
  ];

  // Lấy key theo provider 1 lần/request (pool → env), tái dùng cho nhiều model cùng provider.
  const keyCache = new Map();
  const keysFor = async (p) => { if (!keyCache.has(p)) keyCache.set(p, await candidateKeys(env, p)); return keyCache.get(p); };

  for (const r of route) {
    const provider = r.provider_id, model = r.model_id;
    const cands = await keysFor(provider);
    for (const { key, keyId } of cands) {
      const t0 = Date.now();
      try {
        const { status, score, usage } = await scoreOnce(provider, model, key, systemPrompt, userPrompt);
        if (status === 429) continue;            // key hết quota → key kế tiếp
        if (!score || !score.overall) continue;  // lỗi / parse fail → key kế tiếp
        logUsage(env, ctx, { provider, endpoint: 'score-ai', model, keyId, units: 1,
          tokensIn: (usage && usage.prompt_tokens) || 0, tokensOut: (usage && usage.completion_tokens) || 0,
          status, latencyMs: Date.now() - t0, success: true });
        const tag = String(model).split('/').pop().split('-').slice(0, 3).join('-');
        return json({ ...score, engine: provider + '-' + tag, transcript });
      } catch (_) { /* timeout/network → key kế tiếp */ }
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
  // Người nhận: ALERT_EMAIL nếu đặt, mặc định email chủ tài khoản Resend (gửi được
  // ngay không cần xác thực domain). Sau khi xác thực domain -> đổi sang cfvblue@gmail.com.
  const to = env.ALERT_EMAIL || 'huytruong18122001@gmail.com';
  // from: ALERT_FROM nếu đã xác thực domain; mặc định địa chỉ thử nghiệm của Resend.
  const from = env.ALERT_FROM || 'NghienDe Alert <onboarding@resend.dev>';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
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

  // Nếu có token: chặn user local + bị cấm (không tốn Groq), và free 60'/ngày.
  const gate = await publicUserGate(env, request);
  if (gate && gate.block) return gate.resp;
  if (gate && gate.user) { const q = await freeHourGate(env, gate.user.id); if (q) return q; }

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

  // Chuỗi model STT theo catalog (capability 'stt'); trống → mặc định Groq Whisper turbo.
  // Chỉ Groq hỗ trợ audio hiện tại — key lấy từ pool (api_keys) rồi fallback env GROQ_API_KEY_*.
  const route0 = await routeModels(env, 'stt');
  const route = route0.length ? route0 : [{ provider_id: 'groq', model_id: 'whisper-large-v3-turbo' }];

  let allQuota = true;   // mọi key đều 429 → cảnh báo
  let triedAny = false;
  for (const r of route) {
    if (r.provider_id !== 'groq') continue;
    const cands = await candidateKeys(env, 'groq');
    for (const { key, keyId } of cands) {
      triedAny = true;
      const t0 = Date.now();
      try {
        const groqForm = new FormData();
        groqForm.append('file', file, 'recording.webm');
        groqForm.append('model', r.model_id);
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
        logUsage(env, ctx, { provider: 'groq', endpoint: 'transcribe', model: r.model_id, keyId, units: 1, status: resp.status, latencyMs: Date.now() - t0, success: true });
        return json({ text: data.text || '', words: data.words || [], engine: 'groq-whisper' });
      } catch (_) { allQuota = false; } // timeout/network error: not a quota issue
    }
  }

  if (!triedAny) return json({ error: 'groq_not_configured' }, 503);

  // Hết key (đều 429) -> gửi email cảnh báo ẩn (chống trùng, không chặn người dùng
  // nhờ waitUntil) rồi báo extension chuyển sang phương án miễn phí.
  if (allQuota) {
    const alert = maybeAlertGroqExhausted(env, envKeys(env, 'groq').length || 5);
    if (ctx && ctx.waitUntil) ctx.waitUntil(alert); else await alert;
    return json({ error: 'groq_exhausted', fallback: 'free' }, 503);
  }

  return json({ error: 'groq_unavailable' }, 503);
}

// ── Supabase JWT verification (cache 30s trong isolate để giảm gọi /auth/v1/user) ──
const _tokCache = new Map(); // token → { user, at }
const _TOK_TTL = 30 * 1000;
async function verifyToken(token, env) {
  if (!token) return null;
  const now = Date.now();
  const hit = _tokCache.get(token);
  if (hit && now - hit.at < _TOK_TTL) return hit.user;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
      },
    });
    if (!res.ok) { _tokCache.delete(token); return null; }
    const user = await res.json(); // { id, email, ... }
    _tokCache.set(token, { user, at: now });
    // Chặn phình bộ nhớ: giữ tối đa ~500 token gần nhất / isolate.
    if (_tokCache.size > 500) { const k = _tokCache.keys().next().value; _tokCache.delete(k); }
    return user;
  } catch {
    return null;
  }
}

// ── /pay-info  — thông tin thanh toán CÔNG KHAI cho extension (nâng cấp Pro) ──
// Chỉ trả field an toàn; KHÔNG trả sepay key / bic. Admin sửa trong trang Thanh toán.
async function handlePayInfo(env) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/payout_config?select=beneficiary_name,iban,bank_name,qr_image,price_table,payment_methods&limit=1`, {
      headers: { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return json({ error: 'unavailable' }, 200);
    const rows = await r.json().catch(() => []);
    const c = (rows && rows[0]) || {};
    // Danh sách phương thức đang bật (mọi field đều để hiển thị → an toàn công khai).
    let methods = Array.isArray(c.payment_methods) ? c.payment_methods.filter((m) => m && m.enabled) : [];
    // Tương thích ngược: nếu chưa cấu hình methods → dựng từ iban/qr cũ.
    if (!methods.length) {
      if (c.iban) methods.push({ id: 'iban', type: 'iban', label: 'Chuyển khoản IBAN (EU)', beneficiary: c.beneficiary_name || '', iban: c.iban, bank: c.bank_name || '' });
      if (c.qr_image) methods.push({ id: 'vn_qr', type: 'vn_qr', label: 'QR ngân hàng (VN)', qr_image: c.qr_image });
    }
    // Giá Pro: EUR là nguồn chuẩn (3.99€); VND quy đổi trực tiếp theo tỷ giá ECB/live.
    const pt = c.price_table || {};
    const proEur = normEur(pt.pro && pt.pro.EUR);
    const proVnd = await eurToVnd(proEur);
    const price_table = Object.assign({}, pt, { pro: Object.assign({}, pt.pro, { EUR: proEur, VND: proVnd }) });
    return json({
      beneficiary_name: c.beneficiary_name || '',
      iban: c.iban || '',
      bank_name: c.bank_name || '',
      qr_image: c.qr_image || '',
      price_table,
      methods,
    });
  } catch (_) { return json({ error: 'unavailable' }, 200); }
}

// ── Email + nâng cấp Pro ───────────────────────────────────────────────────
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fillTpl(s, vars) { return String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '')); }

// Mã tham chiếu chuyển khoản (Verwendungszweck): DE- + 5 chữ số ngẫu nhiên (vd DE-48217).
// Khớp regex SePay webhook /\b([A-Z]{2}-[A-Z0-9]{5,9})\b/ → tự cập nhật đơn ở Doanh thu.
function genRef() {
  const u = crypto.getRandomValues(new Uint8Array(5));
  let s = ''; for (let i = 0; i < 5; i++) s += String(u[i] % 10);
  return 'DE-' + s;
}

// ── Tỷ giá EUR→VND trực tiếp, cache 6h. Nhiều nguồn free (không cần key) để chính xác cao:
//   1) open.er-api.com  (ExchangeRate-API open access — cập nhật hằng ngày, có VND)
//   2) @fawazahmed0/currency-api qua jsDelivr (rất phổ biến với dev, free, có VND)
//   3) Frankfurter (ECB) — thường KHÔNG có VND, để cuối cho chắc.
// Lọc giá trị bất thường (EUR→VND thực tế > 25.000); dự phòng 30.500 nếu mọi nguồn lỗi.
let _fxCache = { rate: 0, at: 0 };
const _FX_TTL = 6 * 60 * 60 * 1000;
const _FX_FALLBACK = 30500; // ₫/€ dự phòng (xấp xỉ giá thị trường, luôn > 30.000)
function _validVnd(v) { const n = Number(v); return n && n > 25000 && n < 40000 ? n : 0; }
async function eurToVndRate() {
  const now = Date.now();
  if (_fxCache.rate && now - _fxCache.at < _FX_TTL) return _fxCache.rate;
  // 1) open.er-api.com
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/EUR');
    if (r.ok) { const j = await r.json().catch(() => null); const v = _validVnd(j && j.rates && j.rates.VND); if (v) { _fxCache = { rate: v, at: now }; return v; } }
  } catch (_) {}
  // 2) fawazahmed0 currency-api (jsDelivr CDN)
  try {
    const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json');
    if (r.ok) { const j = await r.json().catch(() => null); const v = _validVnd(j && j.eur && j.eur.vnd); if (v) { _fxCache = { rate: v, at: now }; return v; } }
  } catch (_) {}
  // 3) Frankfurter (ECB) — ít khi có VND
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=VND');
    if (r.ok) { const j = await r.json().catch(() => null); const v = _validVnd(j && j.rates && j.rates.VND); if (v) { _fxCache = { rate: v, at: now }; return v; } }
  } catch (_) {}
  return _FX_FALLBACK;
}
// Chuẩn hoá giá EUR (nếu DB cũ lưu dạng cent như 999 → 9.99). Mặc định 3.99€.
function normEur(x) { let e = Number(x) || 0; if (e >= 100) e = e / 100; return e || 3.99; }
async function eurToVnd(eur) { const rate = await eurToVndRate(); return Math.round(((Number(eur) || 0) * rate) / 1000) * 1000; }
function groupThousands(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function fmtEur(eur) { return Number(eur || 0).toFixed(2) + ' €'; }
function fmtVnd(vnd) { return groupThousands(vnd) + ' ₫'; }

// Email NghienDeutsch (mặc định) — admin override trong app_settings key 'email_pro'.
// Export để admin.js dùng làm fallback hiển thị trong trang Email (nguồn chuẩn 1 chỗ).
export const DEFAULT_PRO_EMAIL = {
  subject: 'NghienDeutsch Pro — Ihre Zahlungsanweisungen ({{ref}})',
  html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Deutsch lernen mit KI — Hören. Sprechen. Verstehen. Jeden Tag besser werden.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Logo -->
  <tr><td style="padding:8px 8px 18px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:20px;font-weight:800;color:#2563EB;letter-spacing:.2px">Nghien<span style="color:#0EA5E9">Deutsch</span></td>
      <td align="right" style="font-size:12px;color:#64748b">Deutsch lernen mit KI</td>
    </tr></table>
  </td></tr>

  <!-- Hero Banner (placeholder: Hero-Bild als Hintergrund möglich) -->
  <tr><td style="background:linear-gradient(135deg,#2563EB 0%,#0EA5E9 100%);border-radius:20px;padding:40px 32px">
    <h1 style="margin:0;font-size:30px;line-height:1.2;color:#ffffff;font-weight:800">Deutsch lernen mit KI.</h1>
    <p style="margin:14px 0 0;font-size:16px;line-height:1.7;color:#e0f2fe">Hören. Sprechen. Verstehen.<br>Jeden Tag besser werden.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr><td style="background:#F59E0B;border-radius:12px">
      <a href="https://nghienducchua-proxy.thoatran21012.workers.dev" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none">Jetzt kostenlos testen</a>
    </td></tr></table>
  </td></tr>

  <!-- Begrüßung + Zahlungsbox -->
  <tr><td style="padding:28px 8px 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;box-shadow:0 1px 3px rgba(15,23,42,.06)"><tr><td style="padding:28px">
      <h2 style="margin:0 0 6px;font-size:21px;color:#0f172a">Willkommen bei {{plan}}, {{name}}! 🎉</h2>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#475569">Vielen Dank für Ihr Upgrade auf <b>NghienDeutsch {{plan}}</b>. Bitte überweisen Sie mit den folgenden Angaben — danach aktivieren wir Ihren {{plan}}-Zugang.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #e2e8f0;border-radius:16px"><tr><td style="padding:20px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;font-weight:700">Zahlung — {{method_label}}</div>
        <div style="font-size:28px;font-weight:800;color:#2563EB;margin:6px 0 4px">{{amount}}</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:12px">Paket: <b style="color:#0f172a">NghienDeutsch {{plan}}</b></div>
        <div style="font-size:14px;line-height:1.7;color:#0f172a">{{method_instructions}}</div>
        <div style="margin-top:14px;padding:11px 14px;background:#FEF3C7;border-radius:10px;font-size:13px;color:#92400e"><b>Verwendungszweck (Pflicht):</b> {{ref}}</div>
      </td></tr></table>
    </td></tr></table>
  </td></tr>

  <!-- Intro -->
  <tr><td style="padding:24px 16px 6px">
    <p style="margin:0;font-size:15px;line-height:1.7;color:#334155">Sie möchten endlich flüssiger Deutsch sprechen? <b>NghienDeutsch</b> verwandelt YouTube und Netflix in einen interaktiven Deutschkurs. Unsere KI bewertet Ihre Aussprache, erklärt Fehler und hilft Ihnen, natürlicher zu sprechen.</p>
  </td></tr>

  <!-- Feature Cards (2x2) -->
  <tr><td style="padding:14px 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="50%" valign="top" style="padding:8px">
        <table role="presentation" width="100%" style="background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06)"><tr><td style="padding:18px">
          <div style="font-size:24px">🎤</div><div style="font-weight:700;margin:6px 0 4px;color:#0f172a">KI-Aussprachebewertung</div><div style="font-size:13px;color:#64748b;line-height:1.5">Feedback Satz für Satz.</div>
        </td></tr></table>
      </td>
      <td width="50%" valign="top" style="padding:8px">
        <table role="presentation" width="100%" style="background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06)"><tr><td style="padding:18px">
          <div style="font-size:24px">📺</div><div style="font-weight:700;margin:6px 0 4px;color:#0f172a">YouTube Shadowing</div><div style="font-size:13px;color:#64748b;line-height:1.5">Direkt im Video üben.</div>
        </td></tr></table>
      </td>
    </tr><tr>
      <td width="50%" valign="top" style="padding:8px">
        <table role="presentation" width="100%" style="background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06)"><tr><td style="padding:18px">
          <div style="font-size:24px">🎬</div><div style="font-weight:700;margin:6px 0 4px;color:#0f172a">Netflix Learning</div><div style="font-size:13px;color:#64748b;line-height:1.5">Filme als Lernstoff.</div>
        </td></tr></table>
      </td>
      <td width="50%" valign="top" style="padding:8px">
        <table role="presentation" width="100%" style="background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06)"><tr><td style="padding:18px">
          <div style="font-size:24px">📖</div><div style="font-weight:700;margin:6px 0 4px;color:#0f172a">KI-Übersetzung &amp; Wortschatz</div><div style="font-size:13px;color:#64748b;line-height:1.5">Im Kontext lernen.</div>
        </td></tr></table>
      </td>
    </tr></table>
  </td></tr>

  <!-- So funktioniert's -->
  <tr><td style="padding:18px 16px 4px">
    <h3 style="margin:0 0 12px;font-size:17px;color:#0f172a">So funktioniert's</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#334155;line-height:1.9">
      <tr><td><b style="color:#2563EB">①</b> &nbsp;Öffnen Sie YouTube oder Netflix.</td></tr>
      <tr><td><b style="color:#2563EB">②</b> &nbsp;Wählen Sie einen Satz.</td></tr>
      <tr><td><b style="color:#2563EB">③</b> &nbsp;Sprechen Sie ihn nach.</td></tr>
      <tr><td><b style="color:#2563EB">④</b> &nbsp;Die KI bewertet Ihre Aussprache.</td></tr>
      <tr><td><b style="color:#2563EB">⑤</b> &nbsp;Wiederholen, bis Sie Ihr Ziel erreichen.</td></tr>
    </table>
  </td></tr>

  <!-- Warum -->
  <tr><td style="padding:18px 16px 4px">
    <h3 style="margin:0 0 10px;font-size:17px;color:#0f172a">Warum NghienDeutsch?</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#334155;line-height:1.9">
      <tr><td>✅ Lernen mit echten Videos</td></tr>
      <tr><td>✅ Sofortiges Feedback</td></tr>
      <tr><td>✅ Mehr Selbstvertrauen beim Sprechen</td></tr>
      <tr><td>✅ Perfekt für Goethe, TELC und den Alltag</td></tr>
    </table>
  </td></tr>

  <!-- Kundenstimme -->
  <tr><td style="padding:16px 8px">
    <table role="presentation" width="100%" style="background:#ffffff;border-left:4px solid #F59E0B;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,.06)"><tr><td style="padding:18px 20px">
      <div style="color:#F59E0B;font-size:15px">★★★★★</div>
      <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#334155;font-style:italic">„Seit ich NghienDeutsch benutze, verstehe ich Filme besser und meine Aussprache ist viel natürlicher geworden."</p>
    </td></tr></table>
  </td></tr>

  <!-- CTA -->
  <tr><td align="center" style="padding:22px 8px 8px">
    <h3 style="margin:0 0 14px;font-size:18px;color:#0f172a">Deutsch intelligenter lernen.</h3>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2563EB;border-radius:12px">
      <a href="https://nghienducchua-proxy.thoatran21012.workers.dev" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">Jetzt kostenlos testen</a>
    </td></tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:26px 16px 8px">
    <table role="presentation" width="100%" style="background:#0f172a;border-radius:16px"><tr><td style="padding:22px 24px;text-align:center">
      <div style="font-size:14px;font-weight:800;color:#ffffff">Nghien<span style="color:#38bdf8">Deutsch</span></div>
      <div style="margin:10px 0;font-size:12px;color:#94a3b8;line-height:1.8">
        <a href="https://nghienducchua-proxy.thoatran21012.workers.dev" style="color:#93c5fd;text-decoration:none">Website</a> ·
        <a href="mailto:thoatran21012@gmail.com" style="color:#93c5fd;text-decoration:none">Support</a> ·
        <a href="mailto:thoatran21012@gmail.com" style="color:#93c5fd;text-decoration:none">E-Mail</a>
      </div>
      <div style="font-size:11px;color:#64748b;line-height:1.7">Impressum · Datenschutz · <a href="#" style="color:#64748b;text-decoration:underline">Unsubscribe</a><br>© NghienDeutsch — Deutsch lernen mit KI</div>
    </td></tr></table>
  </td></tr>

</table></td></tr></table></body></html>`,
};

async function getProEmail(env) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/app_settings?key=eq.email_pro&select=value`, { headers: { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY } });
    if (r.ok) { const rows = await r.json().catch(() => []); const v = rows[0] && rows[0].value; if (v && v.html) return { subject: v.subject || DEFAULT_PRO_EMAIL.subject, html: v.html }; }
  } catch (_) {}
  return DEFAULT_PRO_EMAIL;
}

function methodInstructionsHtml(method, ref) {
  if (!method) return '';
  if (method.type === 'iban') return `IBAN: <b>${escapeHtml(method.iban || '')}</b><br>Empfänger: <b>${escapeHtml(method.beneficiary || '')}</b>` + (method.bank ? `<br>Bank: ${escapeHtml(method.bank)}` : '') + (method.bic ? `<br>BIC: ${escapeHtml(method.bic)}` : '');
  if (method.type === 'vn_qr') return `Quét mã QR bằng app ngân hàng:` + (method.qr_image ? `<br><img src="${method.qr_image}" alt="QR" style="max-width:220px;margin-top:8px;border-radius:8px">` : '');
  if (method.type === 'paypal') return `PayPal: <b>${escapeHtml(method.link || method.email || '')}</b>`;
  return escapeHtml(method.note || '');
}

// Lưu lỗi email gần nhất vào KV để Admin → Health hiển thị (vấn đề #8).
async function noteEmailError(env, provider, status, detail) {
  try { if (env.ALERT_KV) await env.ALERT_KV.put('email_last_error', JSON.stringify({ provider, status, detail: String(detail).slice(0, 300), at: new Date().toISOString() }), { expirationTtl: 7 * 864e5 }); } catch (_) {}
}
async function sendResend(env, to, subject, text) {
  if (!env.RESEND_API_KEY) { console.error('[RESEND-MISSING]', subject); return { ok: false, error: 'no_resend' }; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ALERT_FROM || 'NghienDeutsch <onboarding@resend.dev>', to: [to], subject, text }),
    });
    if (!r.ok) { let d = ''; try { d = JSON.stringify(await r.json()); } catch (_) {} console.error('[RESEND-ERR]', r.status, d.slice(0, 300)); await noteEmailError(env, 'resend', r.status, d); return { ok: false, status: r.status, error: d }; }
    return { ok: true };
  } catch (e) { console.error('[RESEND-FAIL]', e.message); return { ok: false, error: e.message }; }
}
// Gửi email cho CHỦ (owner): ưu tiên Resend, lỗi/thiếu → fallback Brevo (sender đã verify).
async function sendOwnerEmail(env, to, subject, text, html) {
  const r = await sendResend(env, to, subject, text);
  if (r && r.ok) return r;
  return sendBrevo(env, to, 'Admin', subject, html || ('<pre style="font:14px/1.6 monospace;white-space:pre-wrap">' + escapeHtml(text) + '</pre>'));
}

async function sendBrevo(env, toEmail, toName, subject, html) {
  if (!env.BREVO_API_KEY) { console.error('[BREVO-MISSING]'); return { ok: false, error: 'no_brevo' }; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ sender: { name: 'NghienDeutsch', email: env.BREVO_SENDER || 'thoatran21012@gmail.com' }, to: [{ email: toEmail, name: toName || toEmail }], subject, htmlContent: html }),
    });
    if (!r.ok) {
      // Log rõ status + body (vd 400 "sender not verified") để debug trong admin/health.
      let detail = ''; try { detail = JSON.stringify(await r.json()); } catch (_) { try { detail = await r.text(); } catch (__) {} }
      console.error('[BREVO-ERR]', r.status, String(detail).slice(0, 300));
      await noteEmailError(env, 'brevo', r.status, detail);
      return { ok: false, status: r.status, error: String(detail).slice(0, 300) };
    }
    return { ok: true };
  } catch (e) { console.error('[BREVO-FAIL]', e.message); await noteEmailError(env, 'brevo', 0, e.message); return { ok: false, error: e.message }; }
}

async function handleUpgradeRequest(request, env, ctx) {
  let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 160);
  const methodId = String(body.method || '').trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'bad_input', message: 'Vui lòng nhập Họ tên và email hợp lệ.' }, 400);

  const sbHead = { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY };
  const cfgRows = await (await fetch(`${env.SUPABASE_URL}/rest/v1/payout_config?select=*&limit=1`, { headers: sbHead })).json().catch(() => []);
  const cfg = cfgRows[0] || {};
  const methods = Array.isArray(cfg.payment_methods) ? cfg.payment_methods : [];
  const method = methods.find((m) => m.id === methodId) || methods.find((m) => m.enabled) || methods[0] || null;
  const pro = (cfg.price_table && cfg.price_table.pro) || {};
  const eurPrice = normEur(pro.EUR);
  const currency = (method && method.type === 'vn_qr') ? 'VND' : 'EUR';
  const amount = currency === 'VND' ? await eurToVnd(eurPrice) : eurPrice;
  // Dùng mã DE-##### mà extension đã HIỂN THỊ cho khách (nếu hợp lệ) để khớp nội dung CK.
  const provided = String(body.ref || '').trim().toUpperCase();
  const ref = /^DE-\d{5}$/.test(provided) ? provided : genRef();

  // Lưu đơn (pending) kèm thông tin khách → Doanh thu + email không cần join auth.
  await fetch(`${env.SUPABASE_URL}/rest/v1/payments`, {
    method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ reference_code: ref, method: method ? method.type : (methodId || 'iban'), plan: 'pro', amount, currency, status: 'pending', customer_name: name, customer_email: email }),
  }).catch(() => {});

  const amountStr = currency === 'VND' ? fmtVnd(amount) : fmtEur(amount);
  const planLabel = 'Pro';
  const tpl = await getProEmail(env);
  const vars = { name: escapeHtml(name), plan: planLabel, ref, amount: amountStr, method_label: escapeHtml(method ? method.label : ''), method_instructions: methodInstructionsHtml(method, ref) };
  const html = fillTpl(tpl.html, vars);
  const subject = fillTpl(tpl.subject, { ref, name, plan: planLabel });
  const ownerText = `Đơn nâng cấp Pro mới\n\nHọ tên: ${name}\nEmail: ${email}\nPhương thức: ${method ? method.label : methodId}\nVerwendungszweck: ${ref}\nSố tiền: ${amountStr}\nThời gian: ${new Date().toISOString()}`;

  const send = (async () => {
    // Email cho CHỦ (Resend → fallback Brevo nếu Resend thiếu/lỗi) + email cho KHÁCH (Brevo).
    await sendOwnerEmail(env, env.ALERT_EMAIL || 'thoatran21012@gmail.com', 'NghienDeutsch: Đơn Pro mới — ' + ref, ownerText);
    await sendBrevo(env, email, name, subject, html);
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;

  return json({ ok: true, reference_code: ref, amount: amountStr, currency, method: method || null });
}

// Parse User-Agent thô → {device, os, browser} (đủ dùng cho bảng admin).
function parseUA(ua) {
  ua = String(ua || '');
  const os = /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /(iPhone|iPad|iOS)/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown';
  const device = /Mobile|Android|iPhone/.test(ua) ? 'Mobile' : /iPad|Tablet/.test(ua) ? 'Tablet' : 'Desktop';
  return { device, os, browser };
}

// ── /sync  — đồng bộ từ vựng/câu đã lưu theo TÀI KHOẢN (Bearer JWT) ──────────
// pull: trả dữ liệu server. push (replace): lưu nguyên trạng local của client.
// Extension LUÔN pull→merge vào local khi đăng nhập TRƯỚC khi push → push sau đó là superset.
// Guard: bỏ qua push rỗng khi server đang có dữ liệu (chống xoá trắng lúc chưa kịp đồng bộ).
async function handleSync(request, env, user) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body = {}; try { body = await request.json(); } catch (_) {}
  const sbHead = { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
  const getRow = async () => {
    try {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/user_data?user_id=eq.${encodeURIComponent(user.id)}&select=saved_words,saved_sentences,favorites,updated_at`, { headers: sbHead });
      const rows = r.ok ? await r.json().catch(() => []) : [];
      return rows[0] || { saved_words: [], saved_sentences: [], favorites: [] };
    } catch (_) { return { saved_words: [], saved_sentences: [], favorites: [] }; }
  };
  if ((body.action || 'pull') === 'pull') {
    const row = await getRow();
    return json({ ok: true, saved_words: row.saved_words || [], saved_sentences: row.saved_sentences || [], favorites: row.favorites || [], updated_at: row.updated_at || null });
  }
  // push (replace)
  const inW = Array.isArray(body.saved_words) ? body.saved_words : [];
  const inS = Array.isArray(body.saved_sentences) ? body.saved_sentences : [];
  const inF = Array.isArray(body.favorites) ? body.favorites : [];
  if (!inW.length && !inS.length && !inF.length && !body.force) {
    const cur = await getRow();
    if ((cur.saved_words || []).length || (cur.saved_sentences || []).length || (cur.favorites || []).length) {
      return json({ ok: true, skipped: 'empty_guard', saved_words: cur.saved_words || [], saved_sentences: cur.saved_sentences || [], favorites: cur.favorites || [], updated_at: cur.updated_at || null });
    }
  }
  const payload = { user_id: user.id, saved_words: inW.slice(0, 5000), saved_sentences: inS.slice(0, 5000), favorites: inF.slice(0, 5000), updated_at: new Date().toISOString() };
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/user_data`, { method: 'POST', headers: { ...sbHead, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(payload) });
  } catch (_) { return json({ error: 'sync_failed' }, 200); }
  return json({ ok: true, updated_at: payload.updated_at });
}

// ── /session/ping  — ghi nhận đăng nhập/heartbeat + thiết bị + mạng (cho Admin Users 360°) ──
async function handleSessionPing(request, env, user, ctx) {
  let body = {}; try { body = await request.json(); } catch (_) {}
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const cf = request.cf || {};
  const ua = String(body.ua || request.headers.get('User-Agent') || '').slice(0, 400);
  const p = parseUA(ua);
  const ev = {
    user_id: user.id,
    event: (body.event === 'login' || body.event === 'logout') ? body.event : 'ping',
    ip, ua, device: p.device, os: p.os, browser: p.browser,
    screen: String(body.screen || '').slice(0, 20),
    lang: String(body.lang || '').slice(0, 20),
    timezone: String(body.timezone || '').slice(0, 60),
    country: cf.country || '', city: cf.city || '', isp: cf.asOrganization || '',
    method: 'supabase', success: true,
  };
  const sbHead = { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
  const work = (async () => {
    try { await fetch(`${env.SUPABASE_URL}/rest/v1/login_events`, { method: 'POST', headers: { ...sbHead, Prefer: 'return=minimal' }, body: JSON.stringify(ev) }); } catch (_) {}
    // Cập nhật profiles.last_* (dời last_ip → prev_ip khi IP đổi).
    try {
      const cur = (await (await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=last_ip`, { headers: sbHead })).json().catch(() => []))[0] || {};
      const patch = { last_seen_at: new Date().toISOString(), last_ip: ip, last_device: { device: p.device, os: p.os, browser: p.browser, screen: ev.screen, lang: ev.lang, timezone: ev.timezone } };
      if (ev.event === 'login') patch.last_login_at = patch.last_seen_at;
      if (cur.last_ip && cur.last_ip !== ip) patch.prev_ip = cur.last_ip;
      await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, { method: 'PATCH', headers: { ...sbHead, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    } catch (_) {}
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return json({ ok: true });
}

// Đọc nguồn model của user (server|local|dedicated). Fail-safe: 'server'.
async function userModelSource(env, userId) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=model_source`, {
      headers: { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return 'server';
    const rows = await r.json().catch(() => []);
    return (rows[0] && rows[0].model_source) || 'server';
  } catch (_) { return 'server'; }
}

// Cổng cho endpoint công khai (transcribe/score) khi có token: chặn nếu user = local.
// Trả { block:true, resp } để caller return luôn; hoặc { user } khi cho qua; null khi không token.
async function publicUserGate(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const user = await verifyToken(token, env);
  if (!user) return null;
  if (await isBanned(env, user.id)) return { block: true, resp: json({ error: 'banned' }, 403) };
  const ms = await userModelSource(env, user.id);
  if (ms === 'local') return { block: true, resp: json({ error: 'use_local', message: 'Tài khoản đang dùng model LOCAL — không gọi server.' }, 403) };
  return { user };
}

// Free 60'/ngày: gọi RPC free_hour_check (bắt đầu đồng hồ ở lần đầu trong ngày).
// Trả Response 403 khi hết giờ; null khi cho phép (fail-open nếu RPC lỗi/chưa có).
async function freeHourGate(env, userId) {
  const r = await sbRpc(env, 'free_hour_check', { p_user_id: userId });
  // Fail-open có chủ đích (UX > security): RPC lỗi/null → cho qua, nhưng LOG để giám sát.
  if (r == null) { console.error('[FREE_HOUR_FAIL_OPEN] free_hour_check trả null cho user', userId); return null; }
  if (r.allowed === false) {
    return json({ error: 'free_hour_over', message: 'Đã hết 1 giờ dùng thử miễn phí hôm nay. Quay lại ngày mai hoặc nâng cấp Pro để dùng không giới hạn.', resets_tomorrow: true }, 403);
  }
  return null;
}

// Kiểm tra user bị cấm (profiles.banned). Fail-open: lỗi DB KHÔNG tự khoá user.
async function isBanned(env, userId) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=banned`, {
      headers: { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return false;
    const rows = await r.json().catch(() => []);
    return !!(rows && rows[0] && rows[0].banned);
  } catch (_) { return false; }
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
        `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=plan,email,full_name,model_source`,
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

    // Trạng thái giờ free CÒN LẠI (read-only, KHÔNG khởi động đồng hồ). Pro → unlimited.
    const fh = await sbRpc(env, 'free_hour_status', { p_user_id: user.id });

    return json({
      email: profile.email || user.email,
      plan: planName,
      planName: plan.display_name,
      model_source: profile.model_source || 'server', // server | local | dedicated
      free_hour: fh || { plan: planName, unlimited: planName !== 'free', remaining_min: 60, limit_min: 60 },
      usage: {
        translations: { used: usage.translation_count, limit: plan.daily_translations },
        ai:           { used: usage.ai_count,          limit: plan.daily_ai_calls },
      },
    });
  } catch (e) {
    return json({ error: 'profile-error', message: e.message }, 500);
  }
}

// ── Supabase RPC helper (service-role) ───────────────────────
async function sbRpc(env, fn, args) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args || {}),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) { return null; }
}

// ── Catalog model + định tuyến (9Router-style) ──────────────────────────────
// Chuỗi model cho 1 capability ('stt'|'score'|'translate'|'chat'), cache 60s trong isolate.
const _routeCache = new Map(); // capability -> { at, models:[{provider_id, model_id, cost_per_mtok}] }
async function routeModels(env, capability) {
  const now = Date.now();
  const c = _routeCache.get(capability);
  if (c && (now - c.at) < 60000) return c.models;
  const res = await sbRpc(env, 'route_models', { p_capability: capability });
  const arr = Array.isArray(res) ? res : [];
  _routeCache.set(capability, { at: now, models: arr });
  return arr;
}

// Key env cho provider (groq = 5 key, xáo trộn vòng tròn để phân tải).
function envKeys(env, provider) {
  if (provider === 'groq') {
    const ks = [env.GROQ_API_KEY_1, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4, env.GROQ_API_KEY_5].filter(Boolean);
    if (!ks.length) return [];
    const s = Math.floor(Math.random() * ks.length);
    return [...ks.slice(s), ...ks.slice(0, s)];
  }
  const ONE = { openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY', deepl: 'DEEPL_API_KEY', mistral: 'MISTRAL_API_KEY' };
  const v = env[ONE[provider]];
  return v ? [v] : [];
}

// Danh sách key thử cho 1 provider: ưu tiên KEY POOL (api_keys, tự trừ credit) rồi env.
// Mỗi phần tử: { key, keyId } — keyId != null khi lấy từ pool (để log usage gắn key).
async function candidateKeys(env, provider) {
  const out = [];
  const consumed = await sbRpc(env, 'consume_api_key', { p_provider_id: provider, p_requests: 1, p_tokens: 0 });
  if (consumed && consumed.secret_ref) {
    try { const k = await decryptSecret(env, consumed.secret_ref); if (k) out.push({ key: k, keyId: consumed.id || null }); } catch (_) {}
  }
  for (const k of envKeys(env, provider)) out.push({ key: k, keyId: null });
  return out;
}

// Ghi 1 sự kiện usage (không chặn response — gọi qua ctx.waitUntil khi có).
function logUsage(env, ctx, ev) {
  const p = sbRpc(env, 'log_usage', {
    p_provider_id: ev.provider, p_endpoint: ev.endpoint, p_model: ev.model || null,
    p_user_id: ev.userId || null, p_key_id: ev.keyId || null,
    p_units: ev.units || 0, p_tokens_in: ev.tokensIn || 0, p_tokens_out: ev.tokensOut || 0,
    p_success: ev.success !== false, p_status: ev.status || null, p_latency_ms: ev.latencyMs || null,
    p_est_cost: ev.estCost || 0,
  });
  if (ctx && ctx.waitUntil) { try { ctx.waitUntil(p); } catch (_) {} } else { p.catch(() => {}); }
}

// Tên ngôn ngữ đầy đủ cho prompt dịch (LLM cần tên, không phải mã ISO).
const LANG_NAMES = {
  de: 'German', en: 'English', vi: 'Vietnamese', fr: 'French', es: 'Spanish', it: 'Italian',
  ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', tr: 'Turkish',
  pl: 'Polish', id: 'Indonesian', th: 'Thai', hi: 'Hindi', uk: 'Ukrainian', ro: 'Romanian',
  nl: 'Dutch', pt: 'Portuguese', sv: 'Swedish',
};
function langName(code) { return LANG_NAMES[(code || '').toLowerCase()] || code || 'the target language'; }
function transPrompt(text, from, to) {
  return `Translate the following ${langName(from)} text into ${langName(to)}. ` +
    `Output ONLY the translation — no quotes, no notes, no romanization, no explanation.\n\n${text}`;
}

// ── Provider dịch: mỗi hàm nhận (apiKey, text, from, to) → chuỗi đã dịch ──
async function translateGemini(apiKey, text, from, to, env, model) {
  model = model || (env && env.GEMINI_MODEL) || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: transPrompt(text, from, to) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    }),
  });
  if (!resp.ok) throw new Error('gemini-' + resp.status);
  const data = await resp.json();
  const out = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  return (out || '').trim();
}
async function translateDeepL(apiKey, text, from, to) {
  // Key free kết thúc ':fx' → dùng api-free; ngược lại api.deepl.com (Pro).
  const host = /:fx$/.test(apiKey) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', (to || 'vi').toUpperCase());
  if (from) params.append('source_lang', from.toUpperCase());
  const resp = await fetch(`${host}/v2/translate`, {
    method: 'POST',
    headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) throw new Error('deepl-' + resp.status);
  const data = await resp.json();
  return ((data.translations && data.translations[0] && data.translations[0].text) || '').trim();
}
// OpenAI-compatible chat (OpenRouter, Mistral) dùng chung.
async function translateChat(url, apiKey, model, text, from, to, extraHeaders) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a professional translator. Output ONLY the translation — no quotes, no notes.' },
        { role: 'user', content: transPrompt(text, from, to) },
      ],
    }),
  });
  if (!resp.ok) throw new Error('chat-' + resp.status);
  const data = await resp.json();
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}
function translateOpenRouter(apiKey, text, from, to, model) {
  return translateChat('https://openrouter.ai/api/v1/chat/completions', apiKey, model || OR_MODELS[0], text, from, to,
    { 'HTTP-Referer': 'https://shadowecho.app', 'X-Title': 'ShadowEcho' });
}
function translateMistral(apiKey, text, from, to, env, model) {
  model = model || (env && env.MISTRAL_MODEL) || 'mistral-small-latest';
  return translateChat('https://api.mistral.ai/v1/chat/completions', apiKey, model, text, from, to);
}

async function runProvider(env, provider, key, text, from, to, model) {
  switch (provider) {
    case 'gemini':     return translateGemini(key, text, from, to, env, model);
    case 'deepl':      return translateDeepL(key, text, from, to);
    case 'openrouter': return translateOpenRouter(key, text, from, to, model);
    case 'mistral':    return translateMistral(key, text, from, to, env, model);
    default:           return translateGemini(key, text, from, to, env, model);
  }
}

// ── /translate  — dịch theo gói (free→client miễn phí, trả phí→API admin chọn) ──
async function handleTranslate(request, env, userId, ctx) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
  const text = String(body.text || '').slice(0, 5000);
  const from = (body.from || body.source_lang || 'de').toLowerCase();
  const to   = (body.to   || body.target_lang || 'vi').toLowerCase();
  if (!text) return json({ error: 'empty_text' }, 400);

  // Free 60'/ngày: hết giờ → chặn dịch (kể cả dịch miễn phí client).
  { const q = await freeHourGate(env, userId); if (q) return q; }

  // Cấu hình dịch hiệu lực cho user (gói + override) qua RPC.
  const cfg = await sbRpc(env, 'translation_config_for', { p_user_id: userId });
  const isPremium  = cfg ? !!cfg.is_premium : false;
  const freeSource = (cfg && cfg.free_source) || 'free';
  let provider     = (cfg && cfg.provider) || ''; // rỗng = Admin chưa chọn provider

  // User FREE:
  //  - free_source = 'free' (mặc định) → client tự dịch miễn phí (YouTube/Google).
  //  - Admin đổi free_source sang 1 provider → kể cả free cũng dịch qua API đó.
  if (!isPremium) {
    if (freeSource === 'free' || !freeSource) return json({ free: true, provider: 'free', message: 'use_free_client' }, 200);
    provider = freeSource;
  }

  // Admin chưa chọn provider dịch → dùng dịch miễn phí (an toàn, không gọi API nào).
  if (!provider) return json({ free: true, provider: 'free', message: 'no_provider_configured' }, 200);

  // Hạn mức ngày theo gói (basic/pro/lifetime) vẫn áp dụng.
  const quota = await checkQuota(userId, 'translation', env);
  if (!quota.allowed) {
    return json({
      error: 'quota_exceeded',
      message: `Đã đạt hạn mức dịch hôm nay (${quota.used}/${quota.limit}). Nâng cấp gói để dùng thêm.`,
      plan: quota.plan, used: quota.used, limit: quota.limit,
    }, 429);
  }

  // Model từ catalog (model top-priority cho provider này); null → default trong code.
  const route = await routeModels(env, 'translate');
  const model = (route.find((r) => r.provider_id === provider) || {}).model_id || null;

  // Lấy key (pool → env) và gọi provider; ghi usage; lỗi/thiếu key → client fallback free.
  const cands = await candidateKeys(env, provider);
  if (!cands.length) return json({ free: true, provider, error: 'no_key', message: 'Chưa cấu hình key cho provider ' + provider }, 200);
  const { key, keyId } = cands[0];
  const t0 = Date.now();
  try {
    const out = await runProvider(env, provider, key, text, from, to, model);
    if (!out) return json({ free: true, provider, error: 'empty', message: 'use_free_client' }, 200);
    logUsage(env, ctx, { provider, endpoint: 'translate', model, userId, keyId, units: 1, latencyMs: Date.now() - t0, success: true });
    return json({ text: out, src: provider, provider, model, free: false });
  } catch (e) {
    // Provider lỗi → để client fallback dịch miễn phí, không chặn trải nghiệm.
    logUsage(env, ctx, { provider, endpoint: 'translate', model, userId, keyId, units: 1, latencyMs: Date.now() - t0, success: false });
    return json({ free: true, provider, error: String(e.message || e), message: 'use_free_client' }, 200);
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
