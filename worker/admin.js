/**
 * admin.js — Back-office endpoints cho trang Admin (SPA tĩnh trên Cloudflare Pages).
 *
 * Bảo mật:
 *  - Đăng nhập: PBKDF2-HMAC-SHA256 băm mật khẩu (chỉ ở Worker), JWT HMAC ngắn hạn,
 *    có bảng admin_sessions để THU HỒI token, optional TOTP 2FA, khoá khi sai nhiều lần.
 *  - Mọi /admin/* (trừ login/bootstrap) yêu cầu Bearer JWT hợp lệ + session chưa thu hồi.
 *  - Secret nhà cung cấp (api_keys.secret_ref) mã hoá AES-GCM bằng KEY_ENCRYPTION_KEY.
 *
 * Secrets cần thêm (wrangler secret put):
 *   ADMIN_JWT_SECRET     khoá ký JWT phiên admin
 *   KEY_ENCRYPTION_KEY   khoá mã hoá API key lưu trong DB
 *   SEPAY_WEBHOOK_KEY    khoá xác thực webhook SePay
 *   ADMIN_KEY            (đã có) — chỉ dùng cho /admin/bootstrap lần đầu
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ───────────────────────── crypto helpers ─────────────────────────
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64url(buf) { return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 10000; // Cloudflare Workers CPU limit — verifyPassword handles any stored iteration count
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(hash)}`;
}
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts[0] !== 'pbkdf2') return false;
    const hash = await pbkdf2(password, fromB64(parts[2]), parseInt(parts[1], 10));
    const want = fromB64(parts[3]);
    if (hash.length !== want.length) return false;
    let diff = 0; for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ want[i];
    return diff === 0;
  } catch (_) { return false; }
}
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signJWT(payload, secret) {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(h + '.' + p));
  return h + '.' + p + '.' + b64url(sig);
}
async function verifyJWT(token, secret) {
  try {
    const [h, p, s] = String(token || '').split('.');
    if (!h || !p || !s) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64(s), enc.encode(h + '.' + p));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(fromB64(p)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}
// TOTP (RFC 6238) — base32 secret, 30s, ±1 window.
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = ''; for (const c of s) { const v = A.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}
async function totpCode(secret, counter) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const buf = new ArrayBuffer(8); new DataView(buf).setUint32(4, counter);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = sig[19] & 0xf;
  const code = ((sig[o] & 0x7f) << 24) | ((sig[o + 1] & 0xff) << 16) | ((sig[o + 2] & 0xff) << 8) | (sig[o + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}
async function verifyTOTP(secret, token) {
  if (!token) return false;
  const t = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) { if (await totpCode(secret, t + w) === String(token).trim()) return true; }
  return false;
}
function randomBase32(len) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const b = crypto.getRandomValues(new Uint8Array(len)); let s = ''; for (const x of b) s += A[x % 32]; return s; }
function refCode(prefix) { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const b = crypto.getRandomValues(new Uint8Array(7)); let s = ''; for (const x of b) s += A[x % A.length]; return (prefix || '') + s; }

// AES-GCM cho api key lưu DB.
async function aesKeyFromSecret(secret) { const h = await crypto.subtle.digest('SHA-256', enc.encode(secret)); return crypto.subtle.importKey('raw', h, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
async function encryptSecret(env, plain) {
  if (!env.KEY_ENCRYPTION_KEY) return 'plain:' + plain;
  const key = await aesKeyFromSecret(env.KEY_ENCRYPTION_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain)));
  return 'aesgcm:' + b64(iv) + ':' + b64(ct);
}
export async function decryptSecret(env, stored) {
  if (!stored) return '';
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (stored.startsWith('aesgcm:')) {
    try { const [, ivB, ctB] = stored.split(':'); const key = await aesKeyFromSecret(env.KEY_ENCRYPTION_KEY); const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB) }, key, fromB64(ctB)); return dec.decode(pt); } catch (_) { return ''; }
  }
  return stored;
}

// ───────────────────────── Supabase REST ─────────────────────────
function sbHeaders(env) { return { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'apikey': env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' }; }
async function sbGet(env, pathQ) { try { const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathQ}`, { headers: sbHeaders(env) }); return r.ok ? await r.json() : []; } catch (_) { return []; } }
async function sbInsert(env, table, row, prefer = 'return=representation') { const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...sbHeaders(env), Prefer: prefer }, body: JSON.stringify(row) }); return r.ok ? (await r.json().catch(() => [])) : null; }
async function sbPatch(env, table, query, patch) { const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { ...sbHeaders(env), Prefer: 'return=representation' }, body: JSON.stringify(patch) }); return r.ok ? (await r.json().catch(() => [])) : null; }
async function sbDelete(env, table, query) { const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: sbHeaders(env) }); return r.ok; }
// Trả truthy khi RPC thành công (kể cả hàm RETURNS VOID → body null/204), null khi lỗi.
async function rpc(env, fn, args) { const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sbHeaders(env), body: JSON.stringify(args || {}) }); if (!r.ok) return null; const d = await r.json().catch(() => true); return d == null ? true : d; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

async function audit(env, adminId, action, target_type, target_id, before, after, ip) {
  try { await sbInsert(env, 'audit_log', { admin_id: adminId, action, target_type: target_type || null, target_id: target_id ? String(target_id) : null, before: before || null, after: after || null, ip: ip || null }, 'return=minimal'); } catch (_) {}
}
function clientIp(request) { return request.headers.get('CF-Connecting-IP') || 'anon'; }

// Xác thực phiên admin (JWT + session chưa thu hồi). Trả payload hoặc null.
async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !env.ADMIN_JWT_SECRET) return null;
  const payload = await verifyJWT(token, env.ADMIN_JWT_SECRET);
  if (!payload || !payload.jti) return null;
  const rows = await sbGet(env, `admin_sessions?id=eq.${encodeURIComponent(payload.jti)}&select=revoked,expires_at`);
  const s = rows && rows[0];
  if (!s || s.revoked) return null;
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return null;
  return payload;
}

// ───────────────────────── Main router ─────────────────────────
export async function handleAdminV2(request, pathname, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const body = await request.json().catch(() => ({}));
  const ip = clientIp(request);

  // ===== Public (no session): bootstrap + login =====
  if (pathname === '/admin/bootstrap') {
    const existing = await sbGet(env, 'admin_users?select=id&limit=1');
    if (existing && existing.length) return json({ error: 'already_initialized' }, 409);
    if (!body.admin_key || body.admin_key !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 403);
    if (!body.email || !body.password || String(body.password).length < 10) return json({ error: 'weak_password' }, 400);
    const password_hash = await hashPassword(String(body.password));
    const r = await sbInsert(env, 'admin_users', { email: String(body.email).toLowerCase(), password_hash, role: 'owner' });
    return r ? json({ success: true }) : json({ error: 'db_error' }, 500);
  }

  if (pathname === '/admin/login') {
    if (env.RATE_LIMITER) { try { const { success } = await env.RATE_LIMITER.limit({ key: 'adminlogin:' + ip }); if (!success) return json({ error: 'rate_limited' }, 429); } catch (_) {} }
    const email = String(body.email || '').toLowerCase();
    const rows = await sbGet(env, `admin_users?email=eq.${encodeURIComponent(email)}&select=*`);
    const u = rows && rows[0];
    const fail = () => json({ error: 'invalid_credentials' }, 401);
    if (!u) { await pbkdf2('dummy', enc.encode('dummy'), 10000); return fail(); } // chống timing
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) return json({ error: 'locked', message: 'Tài khoản tạm khoá, thử lại sau.' }, 423);
    const okPw = await verifyPassword(String(body.password || ''), u.password_hash);
    if (!okPw) {
      const fails = (u.failed_attempts || 0) + 1;
      const lock = fails >= 5 ? new Date(Date.now() + Math.min(30, fails) * 60000).toISOString() : null;
      await sbPatch(env, 'admin_users', `id=eq.${u.id}`, { failed_attempts: fails, locked_until: lock });
      return fail();
    }
    if (u.totp_enabled) { if (!await verifyTOTP(u.totp_secret, body.totp)) return json({ error: 'totp_required' }, 401); }
    if (!env.ADMIN_JWT_SECRET) return json({ error: 'jwt_not_configured' }, 503);
    const jti = crypto.randomUUID();
    const expSec = Math.floor(Date.now() / 1000) + 60 * 60; // 60 phút
    await sbInsert(env, 'admin_sessions', { id: jti, admin_id: u.id, expires_at: new Date(expSec * 1000).toISOString(), ip, user_agent: (request.headers.get('User-Agent') || '').slice(0, 200) }, 'return=minimal');
    await sbPatch(env, 'admin_users', `id=eq.${u.id}`, { failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() });
    const token = await signJWT({ sub: u.id, email: u.email, role: u.role, jti, exp: expSec }, env.ADMIN_JWT_SECRET);
    await audit(env, u.id, 'auth.login', 'admin', u.id, null, null, ip);
    return json({ token, email: u.email, role: u.role, totp_enabled: !!u.totp_enabled });
  }

  // ===== Session required from here =====
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'unauthorized' }, 401);

  switch (pathname) {
    case '/admin/logout': {
      await sbPatch(env, 'admin_sessions', `id=eq.${admin.jti}`, { revoked: true });
      return json({ success: true });
    }
    case '/admin/me': {
      const meRows = await sbGet(env, `admin_users?id=eq.${admin.sub}&select=totp_enabled`);
      return json({ email: admin.email, role: admin.role, totp_enabled: !!(meRows[0] && meRows[0].totp_enabled) });
    }
    case '/admin/refresh': {
      const jti = crypto.randomUUID();
      const expSec = Math.floor(Date.now() / 1000) + 60 * 60;
      await sbInsert(env, 'admin_sessions', { id: jti, admin_id: admin.sub, expires_at: new Date(expSec * 1000).toISOString(), ip }, 'return=minimal');
      await sbPatch(env, 'admin_sessions', `id=eq.${admin.jti}`, { revoked: true });
      return json({ token: await signJWT({ sub: admin.sub, email: admin.email, role: admin.role, jti, exp: expSec }, env.ADMIN_JWT_SECRET) });
    }
    case '/admin/change-password': {
      if (!body.new_password || String(body.new_password).length < 10) return json({ error: 'weak_password' }, 400);
      const rows = await sbGet(env, `admin_users?id=eq.${admin.sub}&select=password_hash`);
      if (!rows[0] || !await verifyPassword(String(body.old_password || ''), rows[0].password_hash)) return json({ error: 'invalid_credentials' }, 401);
      await sbPatch(env, 'admin_users', `id=eq.${admin.sub}`, { password_hash: await hashPassword(String(body.new_password)) });
      await audit(env, admin.sub, 'auth.change_password', 'admin', admin.sub, null, null, ip);
      return json({ success: true });
    }
    case '/admin/2fa/enroll': {
      const rows0 = await sbGet(env, `admin_users?id=eq.${admin.sub}&select=totp_enabled,password_hash,totp_secret`);
      const u0 = rows0 && rows0[0];
      // Nếu 2FA ĐANG BẬT → chặn re-enroll âm thầm (làm vô hiệu 2FA): yêu cầu xác thực lại
      // bằng mật khẩu HOẶC mã TOTP hiện tại trước khi cấp secret mới.
      if (u0 && u0.totp_enabled) {
        const okPw = body.password && await verifyPassword(String(body.password), u0.password_hash);
        const okTotp = body.totp && await verifyTOTP(u0.totp_secret, body.totp);
        if (!okPw && !okTotp) return json({ error: 'reauth_required' }, 401);
      }
      const secret = randomBase32(32);
      await sbPatch(env, 'admin_users', `id=eq.${admin.sub}`, { totp_secret: secret, totp_enabled: false });
      await audit(env, admin.sub, 'auth.2fa_enroll', 'admin', admin.sub, null, null, ip);
      const label = encodeURIComponent('nghienducchua:' + admin.email);
      return json({ secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=nghienducchua` });
    }
    case '/admin/2fa/verify': {
      const rows = await sbGet(env, `admin_users?id=eq.${admin.sub}&select=totp_secret`);
      if (!rows[0] || !await verifyTOTP(rows[0].totp_secret, body.totp)) return json({ error: 'invalid_totp' }, 400);
      await sbPatch(env, 'admin_users', `id=eq.${admin.sub}`, { totp_enabled: true });
      await audit(env, admin.sub, 'auth.2fa_enable', 'admin', admin.sub, null, null, ip);
      return json({ success: true });
    }
    case '/admin/2fa/disable': {
      // Tắt 2FA: yêu cầu xác thực lại bằng mật khẩu HOẶC mã TOTP hiện tại.
      const rows = await sbGet(env, `admin_users?id=eq.${admin.sub}&select=totp_enabled,password_hash,totp_secret`);
      const u0 = rows && rows[0];
      if (!u0 || !u0.totp_enabled) return json({ success: true }); // đã tắt sẵn
      const okPw = body.password && await verifyPassword(String(body.password), u0.password_hash);
      const okTotp = body.totp && await verifyTOTP(u0.totp_secret, body.totp);
      if (!okPw && !okTotp) return json({ error: 'reauth_required' }, 401);
      await sbPatch(env, 'admin_users', `id=eq.${admin.sub}`, { totp_enabled: false, totp_secret: null });
      await audit(env, admin.sub, 'auth.2fa_disable', 'admin', admin.sub, null, null, ip);
      return json({ success: true });
    }

    // ───────── Dashboard ─────────
    case '/admin/stats/overview': {
      const profiles = await sbGet(env, 'profiles?select=id,plan,created_at');
      const planDist = {}; profiles.forEach((p) => { const k = p.plan || 'free'; planDist[k] = (planDist[k] || 0) + 1; });
      const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
      const newUsers30 = profiles.filter((p) => p.created_at && p.created_at > since30).length;
      const keys = await sbGet(env, 'api_keys?select=provider_id,credit_requests_total,credit_requests_used,credit_tokens_total,credit_tokens_used,status');
      const credits = keys.reduce((a, k) => { a.reqTotal += k.credit_requests_total || 0; a.reqUsed += k.credit_requests_used || 0; a.tokTotal += k.credit_tokens_total || 0; a.tokUsed += k.credit_tokens_used || 0; return a; }, { reqTotal: 0, reqUsed: 0, tokTotal: 0, tokUsed: 0 });
      const pays = await sbGet(env, 'payments?status=eq.paid&select=amount,currency');
      const revenue = {}; pays.forEach((p) => { const c = p.currency || 'EUR'; revenue[c] = (revenue[c] || 0) + (p.amount || 0); });
      return json({
        totalUsers: profiles.length, newUsers30, planDist,
        keys: { active: keys.filter((k) => k.status === 'active').length, exhausted: keys.filter((k) => k.status === 'exhausted').length, total: keys.length },
        credits, revenue, paidCount: pays.length,
      });
    }
    case '/admin/audit/list': {
      const rows = await sbGet(env, 'audit_log?select=*&order=created_at.desc&limit=100');
      return json({ items: rows });
    }

    // ───────── Users ─────────
    case '/admin/users/list': {
      const q = String(body.q || '').trim();
      const sel = 'select=id,email,full_name,plan,created_at,model_source,banned,translation_provider,premium_translate';
      let query = `profiles?${sel}&order=created_at.desc&limit=100`;
      if (q) query = `profiles?${sel}&email=ilike.*${encodeURIComponent(q)}*&limit=100`;
      return json({ items: await sbGet(env, query) });
    }
    case '/admin/users/detail': {
      if (!isUuid(body.user_id)) return json({ error: 'bad_id' }, 400);
      const prof = await sbGet(env, `profiles?id=eq.${body.user_id}&select=*`);
      const usage = await sbGet(env, `usage?user_id=eq.${body.user_id}&select=*&order=date.desc&limit=30`);
      return json({ profile: prof[0] || null, usage });
    }
    case '/admin/users/set-plan': {
      if (!isUuid(body.user_id) || !body.plan) return json({ error: 'bad_args' }, 400);
      const r = await rpc(env, 'admin_set_plan', { p_user_id: body.user_id, p_plan: body.plan, p_months: body.months || 12 });
      await audit(env, admin.sub, 'user.set_plan', 'user', body.user_id, null, { plan: body.plan }, ip);
      return r !== null ? json({ success: true }) : json({ error: 'db_error' }, 500);
    }
    case '/admin/users/model-source': {
      if (!isUuid(body.user_id) || !['server', 'local', 'dedicated'].includes(body.model_source)) return json({ error: 'bad_args' }, 400);
      await sbPatch(env, 'profiles', `id=eq.${body.user_id}`, { model_source: body.model_source, dedicated_api_key_id: body.dedicated_api_key_id || null });
      await audit(env, admin.sub, 'user.model_source', 'user', body.user_id, null, { model_source: body.model_source }, ip);
      return json({ success: true });
    }
    case '/admin/users/quota-override': {
      if (!isUuid(body.user_id)) return json({ error: 'bad_id' }, 400);
      await sbPatch(env, 'profiles', `id=eq.${body.user_id}`, { quota_override: body.quota_override || null });
      await audit(env, admin.sub, 'user.quota_override', 'user', body.user_id, null, body.quota_override || null, ip);
      return json({ success: true });
    }
    case '/admin/users/ban':
    case '/admin/users/unban': {
      if (!isUuid(body.user_id)) return json({ error: 'bad_id' }, 400);
      const banned = pathname.endsWith('/ban');
      await sbPatch(env, 'profiles', `id=eq.${body.user_id}`, { banned });
      await audit(env, admin.sub, banned ? 'user.ban' : 'user.unban', 'user', body.user_id, null, null, ip);
      return json({ success: true });
    }
    case '/admin/users/delete': {
      if (!isUuid(body.user_id)) return json({ error: 'bad_id' }, 400);
      // Xoá auth user (cascade hồ sơ qua FK) + dọn hồ sơ phòng khi thiếu cascade.
      try { await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${body.user_id}`, { method: 'DELETE', headers: sbHeaders(env) }); } catch (_) {}
      await sbDelete(env, 'profiles', `id=eq.${body.user_id}`);
      await audit(env, admin.sub, 'user.delete', 'user', body.user_id, null, null, ip);
      return json({ success: true });
    }

    // ───────── System: providers + API keys + health ─────────
    case '/admin/providers/list': return json({ items: await sbGet(env, 'api_providers?select=*&order=display_name.asc') });
    case '/admin/providers/upsert': {
      if (!body.id) return json({ error: 'bad_args' }, 400);
      const row = { id: body.id, display_name: body.display_name || body.id, kind: body.kind || 'api_key', enabled: body.enabled !== false, base_url: body.base_url || null, docs_url: body.docs_url || null, risk_note: body.risk_note || null };
      await fetch(`${env.SUPABASE_URL}/rest/v1/api_providers`, { method: 'POST', headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(row) });
      await audit(env, admin.sub, 'provider.upsert', 'provider', body.id, null, row, ip);
      return json({ success: true });
    }
    case '/admin/providers/toggle': {
      await sbPatch(env, 'api_providers', `id=eq.${encodeURIComponent(body.id)}`, { enabled: !!body.enabled });
      return json({ success: true });
    }
    case '/admin/keys/list': {
      const rows = await sbGet(env, 'api_keys?select=id,provider_id,label,status,credit_requests_total,credit_requests_used,credit_tokens_total,credit_tokens_used,resets_at,reset_interval,priority,last_used_at,last_error,created_at&order=priority.asc');
      return json({ items: rows }); // KHÔNG trả secret_ref
    }
    case '/admin/keys/add': {
      if (!body.provider_id || !body.secret) return json({ error: 'bad_args' }, 400);
      const row = {
        provider_id: body.provider_id, label: body.label || body.provider_id,
        secret_ref: await encryptSecret(env, String(body.secret)), status: 'active',
        credit_requests_total: body.credit_requests_total || 0, credit_requests_used: 0,
        credit_tokens_total: body.credit_tokens_total || 0, credit_tokens_used: 0,
        reset_interval: body.reset_interval || 'none', priority: body.priority || 100,
        resets_at: body.resets_at || null,
      };
      const r = await sbInsert(env, 'api_keys', row);
      await audit(env, admin.sub, 'key.add', 'api_key', r && r[0] && r[0].id, null, { provider_id: body.provider_id, label: row.label }, ip);
      return r ? json({ success: true, id: r[0] && r[0].id }) : json({ error: 'db_error' }, 500);
    }
    case '/admin/keys/credit': {
      // Thêm hạn mức (vd "Grok: +2000 request +40000 token") — dashboard tự cập nhật.
      if (!isUuid(body.id)) return json({ error: 'bad_id' }, 400);
      const rows = await sbGet(env, `api_keys?id=eq.${body.id}&select=credit_requests_total,credit_tokens_total`);
      if (!rows[0]) return json({ error: 'not_found' }, 404);
      const patch = {
        credit_requests_total: (rows[0].credit_requests_total || 0) + (body.add_requests || 0),
        credit_tokens_total: (rows[0].credit_tokens_total || 0) + (body.add_tokens || 0),
        status: 'active',
      };
      await sbPatch(env, 'api_keys', `id=eq.${body.id}`, patch);
      await audit(env, admin.sub, 'key.credit', 'api_key', body.id, null, { add_requests: body.add_requests || 0, add_tokens: body.add_tokens || 0 }, ip);
      return json({ success: true });
    }
    case '/admin/keys/update': {
      if (!isUuid(body.id)) return json({ error: 'bad_id' }, 400);
      const patch = {};
      ['label', 'status', 'priority', 'reset_interval', 'resets_at', 'credit_requests_total', 'credit_tokens_total'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
      if (body.secret) patch.secret_ref = await encryptSecret(env, String(body.secret));
      await sbPatch(env, 'api_keys', `id=eq.${body.id}`, patch);
      await audit(env, admin.sub, 'key.update', 'api_key', body.id, null, Object.keys(patch), ip);
      return json({ success: true });
    }
    case '/admin/keys/disable': { if (!isUuid(body.id)) return json({ error: 'bad_id' }, 400); await sbPatch(env, 'api_keys', `id=eq.${body.id}`, { status: 'disabled' }); return json({ success: true }); }
    case '/admin/keys/delete': { if (!isUuid(body.id)) return json({ error: 'bad_id' }, 400); await sbDelete(env, 'api_keys', `id=eq.${body.id}`); await audit(env, admin.sub, 'key.delete', 'api_key', body.id, null, null, ip); return json({ success: true }); }

    // ───────── Catalog model (9Router-style: thêm/bật/tắt model theo provider) ─────────
    case '/admin/models/list': {
      const rows = await sbGet(env, 'api_models?select=*&order=capability.asc,priority.asc,display_name.asc');
      return json({ items: rows });
    }
    case '/admin/models/add': {
      if (!body.provider_id || !body.model_id || !body.capability) return json({ error: 'bad_args' }, 400);
      const row = {
        provider_id: body.provider_id, model_id: String(body.model_id).slice(0, 200),
        display_name: body.display_name || body.model_id, capability: body.capability,
        enabled: body.enabled !== false, priority: body.priority || 100,
        cost_per_mtok: body.cost_per_mtok || 0, notes: body.notes || null,
      };
      const r = await sbInsert(env, 'api_models', row);
      await audit(env, admin.sub, 'model.add', 'api_model', r && r[0] && r[0].id, null, { provider_id: body.provider_id, model_id: row.model_id, capability: body.capability }, ip);
      return r ? json({ success: true, id: r[0] && r[0].id }) : json({ error: 'db_error_or_duplicate' }, 500);
    }
    case '/admin/models/update': {
      if (!isUuid(body.id)) return json({ error: 'bad_id' }, 400);
      const patch = {};
      ['display_name', 'enabled', 'priority', 'cost_per_mtok', 'notes', 'model_id', 'capability'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
      await sbPatch(env, 'api_models', `id=eq.${body.id}`, patch);
      await audit(env, admin.sub, 'model.update', 'api_model', body.id, null, Object.keys(patch), ip);
      return json({ success: true });
    }
    case '/admin/models/delete': { if (!isUuid(body.id)) return json({ error: 'bad_id' }, 400); await sbDelete(env, 'api_models', `id=eq.${body.id}`); await audit(env, admin.sub, 'model.delete', 'api_model', body.id, null, null, ip); return json({ success: true }); }

    // ───────── Thống kê usage (dashboard) ─────────
    case '/admin/usage/summary': {
      const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 365);
      const data = await rpc(env, 'usage_summary', { p_days: days });
      return json({ days, items: Array.isArray(data) ? data : [] });
    }

    case '/admin/health': {
      const out = { worker: { ok: true }, supabase: { ok: false }, providers: [] };
      try { const r = await fetch(`${env.SUPABASE_URL}/rest/v1/plans?select=name&limit=1`, { headers: sbHeaders(env) }); out.supabase.ok = r.ok; } catch (_) {}
      const keys = await sbGet(env, 'api_keys?select=provider_id,status,last_error');
      const byProv = {};
      keys.forEach((k) => { const p = byProv[k.provider_id] = byProv[k.provider_id] || { provider_id: k.provider_id, active: 0, total: 0, last_error: null }; p.total++; if (k.status === 'active') p.active++; if (k.last_error) p.last_error = k.last_error; });
      out.providers = Object.values(byProv);
      out.groqEnvKeys = [env.GROQ_API_KEY_1, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4, env.GROQ_API_KEY_5].filter(Boolean).length;
      out.deepl = !!env.DEEPL_API_KEY; out.openrouter = !!env.OPENROUTER_API_KEY;
      // Trạng thái email (vấn đề #8): có cấu hình key không + lỗi gần nhất (lưu ở ALERT_KV).
      out.email = { brevo: !!env.BREVO_API_KEY, resend: !!env.RESEND_API_KEY, sender: env.BREVO_SENDER || 'thoatran21012@gmail.com', last_error: null };
      try { if (env.ALERT_KV) { const e = await env.ALERT_KV.get('email_last_error'); if (e) out.email.last_error = JSON.parse(e); } } catch (_) {}
      // Số model theo capability (cho biết ghi âm/chấm/dịch đã có model chưa).
      const models = await sbGet(env, 'api_models?select=capability,enabled');
      const mc = {};
      models.forEach((m) => { const c = mc[m.capability] = mc[m.capability] || { total: 0, enabled: 0 }; c.total++; if (m.enabled) c.enabled++; });
      out.models = mc;
      return json(out);
    }

    // ───────── Payments ─────────
    case '/admin/payout-config/get': {
      const rows = await sbGet(env, 'payout_config?select=*&limit=1');
      return json({ config: rows[0] || null });
    }
    case '/admin/payout-config/update': {
      const fields = {};
      ['beneficiary_name', 'iban', 'bic', 'bank_name', 'paypal_link', 'sepay_account_number', 'sepay_bank_code', 'iban_ref_prefix', 'sepay_ref_prefix', 'price_table', 'qr_image', 'payment_methods'].forEach((k) => { if (body[k] !== undefined) fields[k] = body[k]; });
      fields.updated_at = new Date().toISOString();
      const existing = await sbGet(env, 'payout_config?select=id&limit=1');
      if (existing[0]) await sbPatch(env, 'payout_config', `id=eq.${existing[0].id}`, fields);
      else await sbInsert(env, 'payout_config', fields, 'return=minimal');
      await audit(env, admin.sub, 'payout_config.update', 'config', null, null, Object.keys(fields), ip);
      return json({ success: true });
    }
    // ───────── Doanh thu: đơn Pro (kèm thông tin khách) ─────────
    case '/admin/revenue/list': {
      const rows = await sbGet(env, 'payments?select=reference_code,customer_name,customer_email,plan,amount,currency,status,created_at,paid_at&order=created_at.desc&limit=200');
      const paid = rows.filter((p) => p.status === 'paid');
      const totals = {}; paid.forEach((p) => { const c = p.currency || 'EUR'; totals[c] = (totals[c] || 0) + Number(p.amount || 0); });
      return json({ items: rows, totals, paid_count: paid.length });
    }
    // ───────── Email template (Pro) ─────────
    case '/admin/email-template/get': {
      const rows = await sbGet(env, "app_settings?key=eq.email_pro&select=value");
      return json({ value: (rows[0] && rows[0].value) || null });
    }
    case '/admin/email-template/set': {
      const value = { subject: String(body.subject || '').slice(0, 300), html: String(body.html || '').slice(0, 60000) };
      await fetch(`${env.SUPABASE_URL}/rest/v1/app_settings`, { method: 'POST', headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ key: 'email_pro', value, updated_at: new Date().toISOString() }) });
      await audit(env, admin.sub, 'email_template.set', 'email', 'email_pro', null, null, ip);
      return json({ success: true });
    }
    // ───────── User 360°: chi tiết hồ sơ + thiết bị + mạng + lịch sử đăng nhập ─────────
    case '/admin/users/detail': {
      if (!isUuid(body.user_id)) return json({ error: 'bad_id' }, 400);
      const uid = body.user_id;
      const prof = (await sbGet(env, `profiles?id=eq.${uid}&select=*`))[0] || null;
      const events = await sbGet(env, `login_events?user_id=eq.${uid}&select=*&order=ts.desc&limit=50`);
      // Phiên/thiết bị hoạt động: ping trong 15 phút gần nhất, đếm device khác nhau.
      const since = new Date(Date.now() - 15 * 60000).toISOString();
      const active = events.filter((e) => e.event === 'ping' && e.ts > since);
      const devices = new Set(active.map((e) => (e.device || '') + '|' + (e.os || '') + '|' + (e.browser || '')));
      const anomaly = events.length >= 2 && events[0].country && events[1].country && events[0].country !== events[1].country;
      const subs = await sbGet(env, `subscriptions?user_id=eq.${uid}&select=plan,status,current_period_end&order=created_at.desc&limit=1`);
      return json({ profile: prof, events, active_sessions: devices.size, anomaly, subscription: subs[0] || null });
    }
    case '/admin/payments/list': {
      const rows = await sbGet(env, 'payments?select=*&order=created_at.desc&limit=100');
      return json({ items: rows });
    }
    case '/admin/payments/create-order': {
      const cfg = (await sbGet(env, 'payout_config?select=*&limit=1'))[0] || {};
      const method = body.method || 'iban';
      const prefix = method === 'sepay' ? (cfg.sepay_ref_prefix || 'VN-') : (cfg.iban_ref_prefix || 'DE-');
      const code = refCode(prefix);
      const row = { reference_code: code, user_id: isUuid(body.user_id) ? body.user_id : null, method, plan: body.plan || 'pro', amount: body.amount || 0, currency: body.currency || (method === 'sepay' ? 'VND' : 'EUR'), status: 'pending' };
      const r = await sbInsert(env, 'payments', row);
      await audit(env, admin.sub, 'payment.create_order', 'payment', r && r[0] && r[0].id, null, { code, method }, ip);
      const instructions = method === 'iban'
        ? { beneficiary_name: cfg.beneficiary_name, iban: cfg.iban, bic: cfg.bic, bank_name: cfg.bank_name, amount: row.amount, currency: row.currency, reference: code }
        : method === 'paypal' ? { paypal_link: cfg.paypal_link, reference: code }
          : { account: cfg.sepay_account_number, bank: cfg.sepay_bank_code, amount: row.amount, content: code };
      return json({ success: true, reference_code: code, instructions });
    }
    case '/admin/payments/mark-paid': {
      if (!body.reference_code && !body.id) return json({ error: 'bad_args' }, 400);
      const q = body.id ? `id=eq.${body.id}` : `reference_code=eq.${encodeURIComponent(body.reference_code)}`;
      const rows = await sbPatch(env, 'payments', q, { status: 'paid', paid_at: new Date().toISOString() });
      const pay = rows && rows[0];
      if (pay && pay.user_id && pay.plan) { await rpc(env, 'admin_set_plan', { p_user_id: pay.user_id, p_plan: pay.plan, p_months: 12 }); }
      await audit(env, admin.sub, 'payment.mark_paid', 'payment', pay && pay.id, null, { plan: pay && pay.plan }, ip);
      return json({ success: true });
    }

    // ───────── Cấu hình dịch (provider mặc định cho gói trả phí) ─────────
    case '/admin/settings/translation/get': {
      const rows = await sbGet(env, "app_settings?key=eq.translation&select=value");
      const value = (rows[0] && rows[0].value) || { paid_provider: 'gemini', free_source: 'free' };
      // Kèm danh sách provider đang bật (dùng cho dropdown ở UI).
      const providers = await sbGet(env, 'api_providers?select=id,display_name,enabled,kind&order=display_name.asc');
      return json({ value, providers });
    }
    case '/admin/settings/translation/set': {
      const value = {
        paid_provider: String(body.paid_provider || 'gemini'),
        free_source: String(body.free_source || 'free'),
      };
      await fetch(`${env.SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: 'translation', value, updated_at: new Date().toISOString() }),
      });
      await audit(env, admin.sub, 'settings.translation', 'config', 'translation', null, value, ip);
      return json({ success: true, value });
    }
    case '/admin/users/translation': {
      if (!isUuid(body.user_id)) return json({ error: 'bad_id' }, 400);
      const patch = {};
      // provider: '' / null = theo mặc định hệ thống.
      if (body.translation_provider !== undefined) patch.translation_provider = body.translation_provider || null;
      if (body.premium_translate !== undefined) patch.premium_translate = !!body.premium_translate;
      await sbPatch(env, 'profiles', `id=eq.${body.user_id}`, patch);
      await audit(env, admin.sub, 'user.translation', 'user', body.user_id, null, patch, ip);
      return json({ success: true });
    }

    default: return json({ error: 'unknown_admin_action', pathname }, 404);
  }
}

// ───────────────────────── SePay webhook (công khai) ─────────────────────────
export async function handleSepayWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Apikey ') ? auth.slice(7).trim() : '';
  if (!env.SEPAY_WEBHOOK_KEY || key !== env.SEPAY_WEBHOOK_KEY) return json({ success: false, error: 'unauthorized' }, 401);
  // Đọc raw để (tuỳ chọn) xác thực HMAC-SHA256 khi đã cấu hình SEPAY_HMAC_SECRET (vấn đề #4/#5).
  const raw = await request.text();
  if (env.SEPAY_HMAC_SECRET) {
    const sig = (request.headers.get('X-Sepay-Signature') || request.headers.get('X-Signature') || '').trim().toLowerCase();
    try {
      const k = await crypto.subtle.importKey('raw', enc.encode(env.SEPAY_HMAC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = await crypto.subtle.sign('HMAC', k, enc.encode(raw));
      const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (!sig || sig !== hex) return json({ success: false, error: 'bad_signature' }, 401);
    } catch (_) { return json({ success: false, error: 'sig_error' }, 401); }
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
  const txnId = String(body.id || body.referenceCode || '');
  const content = String(body.content || body.description || '');
  const amount = Number(body.transferAmount || body.amount || 0);
  // Dedupe theo provider_txn_id.
  if (txnId) { const dup = await sbGet(env, `payments?provider_txn_id=eq.${encodeURIComponent(txnId)}&select=id&limit=1`); if (dup && dup.length) return json({ success: true, dedupe: true }); }
  // Tìm mã tham chiếu VN-xxxxxxx / DE-xxxxxxx trong nội dung chuyển khoản.
  const m = /\b([A-Z]{2}-[A-Z0-9]{5,9})\b/.exec(content.toUpperCase());
  if (!m) return json({ success: true, matched: false });
  const code = m[1];
  const rows = await sbGet(env, `payments?reference_code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
  const pay = rows && rows[0];
  if (!pay) return json({ success: true, matched: false });
  if (pay.status === 'paid') return json({ success: true, already: true });
  // Số tiền thiếu/0/không hợp lệ → KHÔNG đánh dấu đã trả (chống cấp gói khi callback rỗng số tiền).
  if (pay.amount && (!amount || amount < pay.amount)) return json({ success: true, underpaid: true });
  // Sai tiền tệ (chỉ kiểm khi webhook có gửi currency) → từ chối.
  if (pay.currency && body.currency && String(body.currency).toUpperCase() !== String(pay.currency).toUpperCase()) return json({ success: true, currency_mismatch: true });
  await sbPatch(env, 'payments', `id=eq.${pay.id}`, { status: 'paid', paid_at: new Date().toISOString(), provider_txn_id: txnId || null, raw_payload: body });
  if (pay.user_id && pay.plan) { await rpc(env, 'admin_set_plan', { p_user_id: pay.user_id, p_plan: pay.plan, p_months: 12 }); }
  return json({ success: true });
}

// ───────────────────────── Cron: reset hạn mức + dọn session ─────────────────────────
export async function scheduledAdmin(env) {
  try {
    const now = Date.now();
    const keys = await sbGet(env, 'api_keys?select=id,reset_interval,resets_at');
    for (const k of keys) {
      if (k.reset_interval && k.reset_interval !== 'none' && k.resets_at && new Date(k.resets_at).getTime() <= now) {
        const next = new Date(now + (k.reset_interval === 'weekly' ? 7 : 1) * 864e5).toISOString();
        await sbPatch(env, 'api_keys', `id=eq.${k.id}`, { credit_requests_used: 0, credit_tokens_used: 0, status: 'active', resets_at: next });
      }
    }
    // Dọn session hết hạn.
    await sbDelete(env, 'admin_sessions', `expires_at=lt.${new Date(now - 864e5).toISOString()}`);
    // Gộp usage_rollup_daily cho NGÀY HÔM QUA (vấn đề #4 — bảng trước đây không được điền).
    try { await rpc(env, 'rollup_usage_daily', {}); } catch (e) { console.error('[ROLLUP-FAIL]', (e && e.message) || e); }
  } catch (_) {}
}
