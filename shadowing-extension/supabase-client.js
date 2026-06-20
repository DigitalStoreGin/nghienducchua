/**
 * ShadowEcho — Lightweight Supabase Auth Client
 * No npm dependency — uses fetch + Supabase REST API directly.
 * Exposes window.ShadowAuth (singleton).
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'shadowecho_session';

  class ShadowAuthClient {
    constructor() {
      this._session  = null;
      this._listeners = [];
    }

    // ── Init: restore persisted session, maybe refresh ──────
    async init() {
      const stored = await this._loadSession();
      if (!stored) { this._emit(null); return null; }

      this._session = stored;
      if (this._isExpiringSoon()) {
        const refreshed = await this.refreshSession();
        if (!refreshed) { this._session = null; this._emit(null); return null; }
      }

      this._emit(this._session);
      return this._session;
    }

    // ── Sign in with email/password ──────────────────────────
    async signIn(email, password) {
      const res = await fetch(
        `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`,
        {
          method: 'POST',
          headers: this._anonHeaders(),
          body: JSON.stringify({ email, password }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || 'Đăng nhập thất bại');

      this._session = data;
      await this._saveSession(data);
      this._emit(data);
      return data;
    }

    // ── Sign up ──────────────────────────────────────────────
    async signUp(email, password) {
      const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: this._anonHeaders(),
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || 'Đăng ký thất bại');
      return data;
    }

    // ── Forgot password (send reset email) ──────────────────
    async resetPassword(email) {
      const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: this._anonHeaders(),
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error_description || data.msg || 'Không thể gửi email đặt lại mật khẩu');
      }
    }

    // ── Sign out ─────────────────────────────────────────────
    async signOut() {
      const token = this.getAccessToken();
      if (token) {
        await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { ...this._anonHeaders(), 'Authorization': `Bearer ${token}` },
        }).catch(() => {});
      }
      this._session = null;
      await this._clearSession();
      this._emit(null);
    }

    // ── Refresh JWT ──────────────────────────────────────────
    async refreshSession() {
      const refreshToken = this._session?.refresh_token;
      if (!refreshToken) return null;

      const res = await fetch(
        `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        {
          method: 'POST',
          headers: this._anonHeaders(),
          body: JSON.stringify({ refresh_token: refreshToken }),
        }
      );

      if (!res.ok) {
        this._session = null;
        await this._clearSession();
        return null;
      }

      const data = await res.json();
      this._session = data;
      await this._saveSession(data);
      return data;
    }

    // ── Accessors ────────────────────────────────────────────
    getAccessToken() { return this._session?.access_token || null; }
    getUser()        { return this._session?.user || null; }
    isLoggedIn()     { return !!this._session?.access_token; }

    // ── Subscribe to auth state changes ─────────────────────
    onAuthStateChange(fn) {
      this._listeners.push(fn);
      return () => { this._listeners = this._listeners.filter(f => f !== fn); };
    }

    // ── Authorization header for Worker calls ───────────────
    workerHeaders() {
      const token = this.getAccessToken();
      return {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      };
    }

    // ── Private helpers ──────────────────────────────────────
    _anonHeaders() {
      return { 'Content-Type': 'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY };
    }

    _isExpiringSoon() {
      if (!this._session?.expires_at) return false;
      return (this._session.expires_at * 1000 - Date.now()) < 5 * 60 * 1000;
    }

    _emit(session) {
      this._listeners.forEach(fn => fn(session?.user || null, session));
    }

    async _saveSession(session) {
      await chrome.storage.local.set({ [STORAGE_KEY]: session });
    }

    async _loadSession() {
      const s = await chrome.storage.local.get(STORAGE_KEY);
      return s[STORAGE_KEY] || null;
    }

    async _clearSession() {
      await chrome.storage.local.remove(STORAGE_KEY);
    }
  }

  window.ShadowAuth = new ShadowAuthClient();
})();
