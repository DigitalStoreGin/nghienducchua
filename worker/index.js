/**
 * ShadowEcho — Cloudflare Worker v2
 *
 * Architecture:
 *   Chrome Extension → Bearer JWT (Supabase) → this Worker → DeepL / OpenRouter
 *
 * Worker Secrets (wrangler secret put):
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (sb_secret_...)
 *   DEEPL_API_KEY         DeepL auth key
 *   OPENROUTER_API_KEY    OpenRouter key
 *   ADMIN_KEY             admin API key for management endpoints
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
};

const OR_MODELS = [
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Main dispatcher ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Public health check
    if (url.pathname === '/health') {
      return json({ ok: true, version: '2.0.0', arch: 'supabase-jwt' });
    }

    // Admin endpoints (internal use only)
    if (url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, url.pathname, env);
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
        `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=plan,email,full_name`,
        {
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
          },
        }
      ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/usage?user_id=eq.${user.id}&date=eq.${today()}&select=translation_count,ai_count`,
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
    const usage    = usages[0]   || { translation_count: 0, ai_count: 0 };

    // Get plan quotas
    const planRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/plans?name=eq.${profile.plan}&select=daily_translations,daily_ai_calls,display_name`,
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
      plan: profile.plan,
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
    const model = OR_MODELS.includes(body.model) ? body.model : OR_MODELS[0];

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
    if (!user_id || !plan) return json({ error: 'missing user_id or plan' }, 400);

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
    if (!user_id) return json({ error: 'missing user_id' }, 400);

    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/usage?user_id=eq.${user_id}&order=date.desc&limit=30`,
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

function today() {
  return new Date().toISOString().split('T')[0];
}
