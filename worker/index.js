/**
 * Cloudflare Worker - NghienDucChua API Proxy
 * API keys stored as encrypted Worker Secrets (never exposed to client)
 * License key validation via KV store
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-License-Key, X-Admin-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, version: '1.0.0' });
    }

    if (url.pathname === '/admin/license') {
      return handleAdminLicense(request, env);
    }

    // All other routes require license key
    const licenseKey = request.headers.get('X-License-Key') || '';
    const valid = await validateLicense(licenseKey, env);
    if (!valid) {
      return json({ error: 'Invalid or inactive license key. Contact seller.' }, 401);
    }

    if (url.pathname === '/translate') {
      return handleDeepL(request, env);
    }

    if (url.pathname === '/ai-translate') {
      return handleOpenRouter(request, env);
    }

    return json({ error: 'Not found' }, 404);
  },
};

async function validateLicense(key, env) {
  if (!key || key.length < 8) return false;
  try {
    const value = await env.LICENSES.get(key);
    if (!value) return false;
    const data = JSON.parse(value);
    return data.active === true;
  } catch {
    return false;
  }
}

async function handleDeepL(request, env) {
  try {
    const body = await request.json();
    const params = new URLSearchParams();
    params.append('text', body.text || '');
    params.append('target_lang', body.target_lang || 'VI');
    if (body.source_lang) params.append('source_lang', body.source_lang);

    const resp = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': 'DeepL-Auth-Key ' + env.DEEPL_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: 'deepl-' + resp.status, details: data }, resp.status);
    return json(data);
  } catch (e) {
    return json({ error: 'deepl-error', message: e.message }, 500);
  }
}

async function handleOpenRouter(request, env) {
  try {
    const body = await request.json();
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://nghienducchua.app',
        'X-Title': 'NghienDucChua Language Learning',
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: 'openrouter-' + resp.status, details: data }, resp.status);
    return json(data);
  } catch (e) {
    return json({ error: 'openrouter-error', message: e.message }, 500);
  }
}

async function handleAdminLicense(request, env) {
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (adminKey !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 403);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const { action, key, email, tier } = body;

    if (action === 'create') {
      const licenseKey = key || generateKey();
      await env.LICENSES.put(licenseKey, JSON.stringify({
        active: true,
        email: email || '',
        tier: tier || 'standard',
        createdAt: new Date().toISOString(),
      }));
      return json({ success: true, key: licenseKey });
    }

    if (action === 'revoke') {
      const existing = await env.LICENSES.get(key);
      if (!existing) return json({ error: 'Key not found' }, 404);
      const data = JSON.parse(existing);
      data.active = false;
      await env.LICENSES.put(key, JSON.stringify(data));
      return json({ success: true });
    }

    if (action === 'list') {
      const list = await env.LICENSES.list();
      const keys = list.keys.map(k => k.name);
      return json({ keys });
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `NDC-${seg()}-${seg()}-${seg()}`;
}
