/* NghienDe Admin SPA — vanilla JS. Đăng nhập JWT, 4 trang: Tổng quan / Hệ thống / User / Thanh toán.
 * Song ngữ vi/de, sáng/tối. Mọi secret nằm ở Worker; trang này chỉ giữ token phiên (sessionStorage). */
(function () {
  'use strict';
  const WORKER = (window.ADMIN_CONFIG && window.ADMIN_CONFIG.WORKER_URL) || '';
  const app = document.getElementById('app');

  // ───────── DOM helper ─────────
  function h(tag, props) {
    const e = document.createElement(tag);
    const kids = Array.prototype.slice.call(arguments, 2);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    kids.flat().forEach((kid) => { if (kid == null || kid === false) return; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  // ───────── i18n ─────────
  const I18N = {
    vi: {
      brand: 'NghienDe Admin', login_sub: 'Khu vực quản trị — chỉ dành cho chủ sở hữu',
      email: 'Email', password: 'Mật khẩu', totp: 'Mã 2FA (nếu bật)', login: 'Đăng nhập',
      bootstrap: 'Khởi tạo lần đầu', admin_key: 'ADMIN_KEY (khởi tạo)', create_owner: 'Tạo tài khoản chủ',
      logout: 'Đăng xuất', loading: 'Đang tải…', error: 'Lỗi', saved: 'Đã lưu', confirm_delete: 'Xoá vĩnh viễn? Không thể hoàn tác.',
      nav_dash: 'Tổng quan', nav_system: 'Hệ thống', nav_users: 'Người dùng', nav_pay: 'Thanh toán',
      // dashboard
      total_users: 'Tổng người dùng', new_30d: 'Mới (30 ngày)', plan_dist: 'Phân bố gói', api_keys: 'API keys',
      keys_active: 'đang chạy', keys_exhausted: 'hết hạn mức', credits_req: 'Lượt gọi API (đã dùng / tổng)',
      credits_tok: 'Token (đã dùng / tổng)', revenue: 'Doanh thu (đã thanh toán)', audit: 'Nhật ký quản trị', paid_count: 'Đơn đã trả',
      // system
      health: 'Tình trạng hệ thống', worker: 'Worker', supabase: 'Supabase', providers: 'Nhà cung cấp', add_key: 'Thêm API key',
      provider: 'Nhà cung cấp', label: 'Nhãn', secret: 'API key / secret', requests: 'Lượt gọi', tokens: 'Token', priority: 'Ưu tiên',
      status: 'Trạng thái', actions: 'Thao tác', add: 'Thêm', add_credit: 'Thêm hạn mức', disable: 'Tắt', enabled: 'Bật',
      reset_interval: 'Chu kỳ reset', interval_none: 'Không', interval_daily: 'Hàng ngày', interval_weekly: 'Hàng tuần',
      add_credit_req: 'Thêm bao nhiêu LƯỢT GỌI?', add_credit_tok: 'Thêm bao nhiêu TOKEN?', session_warning: 'Kết nối qua session (rủi ro ToS) — mặc định TẮT',
      groq_env: 'Groq keys (biến môi trường)', deepl: 'DeepL', openrouter: 'OpenRouter',
      // translation settings
      trans_settings: 'Cấu hình dịch (gói trả phí)', trans_paid_provider: 'API dịch cho gói TRẢ PHÍ', trans_free_source: 'Gói FREE dịch bằng',
      trans_free_youtube: 'Miễn phí (YouTube/Google)', trans_note: 'User free luôn dùng dịch miễn phí. User trả phí dùng API chọn ở đây (lấy key từ pool bên dưới).',
      trans_provider: 'API dịch', trans_default_sys: 'Theo hệ thống', premium_translate: 'Ép dịch API',
      // users
      search_user: 'Tìm theo email…', plan: 'Gói', model_source: 'Nguồn chấm', created: 'Ngày tạo', ban: 'Cấm', unban: 'Bỏ cấm',
      banned: 'Đã cấm', delete: 'Xoá', detail: 'Chi tiết', usage_30d: 'Sử dụng 30 ngày', src_server: 'Server (API)', src_local: 'Local (Whisper)', src_dedicated: 'API riêng',
      // payments
      payout_cfg: 'Thông tin nhận tiền', beneficiary: 'Tên người nhận', iban: 'IBAN', bic: 'BIC', bank: 'Tên ngân hàng',
      paypal: 'Link PayPal donate', sepay_acc: 'Số tài khoản SePay', sepay_bank: 'Mã ngân hàng SePay', iban_prefix: 'Tiền tố mã IBAN',
      sepay_prefix: 'Tiền tố mã SePay', price_table: 'Bảng giá (JSON)', save: 'Lưu', create_order: 'Tạo đơn',
      method: 'Phương thức', amount: 'Số tiền', currency: 'Tiền tệ', user_id_opt: 'User ID (tuỳ chọn)', orders: 'Đơn thanh toán',
      ref_code: 'Mã tham chiếu', mark_paid: 'Đánh dấu đã trả', order_instructions: 'Hướng dẫn chuyển khoản', reference: 'Nội dung CK',
      pending: 'Chờ', paid: 'Đã trả', theme: 'Sáng/Tối', lang: 'Ngôn ngữ', none: '—',
    },
    de: {
      brand: 'NghienDe Admin', login_sub: 'Administrationsbereich — nur für den Inhaber',
      email: 'E-Mail', password: 'Passwort', totp: '2FA-Code (falls aktiv)', login: 'Anmelden',
      bootstrap: 'Ersteinrichtung', admin_key: 'ADMIN_KEY (Einrichtung)', create_owner: 'Inhaber-Konto erstellen',
      logout: 'Abmelden', loading: 'Lädt…', error: 'Fehler', saved: 'Gespeichert', confirm_delete: 'Endgültig löschen? Nicht umkehrbar.',
      nav_dash: 'Übersicht', nav_system: 'System', nav_users: 'Nutzer', nav_pay: 'Zahlungen',
      total_users: 'Nutzer gesamt', new_30d: 'Neu (30 Tage)', plan_dist: 'Tarifverteilung', api_keys: 'API-Schlüssel',
      keys_active: 'aktiv', keys_exhausted: 'aufgebraucht', credits_req: 'API-Aufrufe (genutzt / gesamt)',
      credits_tok: 'Token (genutzt / gesamt)', revenue: 'Umsatz (bezahlt)', audit: 'Admin-Protokoll', paid_count: 'Bezahlte Aufträge',
      health: 'Systemzustand', worker: 'Worker', supabase: 'Supabase', providers: 'Anbieter', add_key: 'API-Schlüssel hinzufügen',
      provider: 'Anbieter', label: 'Bezeichnung', secret: 'API-Schlüssel / Secret', requests: 'Aufrufe', tokens: 'Token', priority: 'Priorität',
      status: 'Status', actions: 'Aktionen', add: 'Hinzufügen', add_credit: 'Kontingent +', disable: 'Aus', enabled: 'An',
      reset_interval: 'Reset-Intervall', interval_none: 'Keins', interval_daily: 'Täglich', interval_weekly: 'Wöchentlich',
      add_credit_req: 'Wie viele AUFRUFE hinzufügen?', add_credit_tok: 'Wie viele TOKEN hinzufügen?', session_warning: 'Session-Verbindung (ToS-Risiko) — standardmäßig AUS',
      groq_env: 'Groq-Schlüssel (Umgebung)', deepl: 'DeepL', openrouter: 'OpenRouter',
      trans_settings: 'Übersetzung (zahlende Tarife)', trans_paid_provider: 'Übersetzungs-API (ZAHLEND)', trans_free_source: 'FREE übersetzt mit',
      trans_free_youtube: 'Kostenlos (YouTube/Google)', trans_note: 'Free-Nutzer nutzen kostenlose Übersetzung. Zahlende nutzen die hier gewählte API (Schlüssel aus dem Pool unten).',
      trans_provider: 'Übersetzungs-API', trans_default_sys: 'System-Standard', premium_translate: 'API erzwingen',
      search_user: 'Nach E-Mail suchen…', plan: 'Tarif', model_source: 'Bewertungsquelle', created: 'Erstellt', ban: 'Sperren', unban: 'Entsperren',
      banned: 'Gesperrt', delete: 'Löschen', detail: 'Details', usage_30d: 'Nutzung 30 Tage', src_server: 'Server (API)', src_local: 'Lokal (Whisper)', src_dedicated: 'Eigene API',
      payout_cfg: 'Zahlungsempfänger', beneficiary: 'Empfängername', iban: 'IBAN', bic: 'BIC', bank: 'Bankname',
      paypal: 'PayPal-Spendenlink', sepay_acc: 'SePay-Kontonummer', sepay_bank: 'SePay-Bankcode', iban_prefix: 'IBAN-Code-Präfix',
      sepay_prefix: 'SePay-Code-Präfix', price_table: 'Preistabelle (JSON)', save: 'Speichern', create_order: 'Auftrag erstellen',
      method: 'Methode', amount: 'Betrag', currency: 'Währung', user_id_opt: 'User-ID (optional)', orders: 'Zahlungsaufträge',
      ref_code: 'Referenzcode', mark_paid: 'Als bezahlt markieren', order_instructions: 'Überweisungsdetails', reference: 'Verwendungszweck',
      pending: 'Offen', paid: 'Bezahlt', theme: 'Hell/Dunkel', lang: 'Sprache', none: '—',
    },
  };
  let lang = localStorage.getItem('admin_lang') || 'vi';
  const t = (k) => (I18N[lang] && I18N[lang][k]) || (I18N.vi[k]) || k;
  function setLang(l) { lang = l; localStorage.setItem('admin_lang', l); document.documentElement.lang = l; render(); }
  const nf = () => new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'vi-VN');
  const fmt = (n) => nf().format(Number(n) || 0);
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString(lang === 'de' ? 'de-DE' : 'vi-VN') : '—';

  // ───────── theme ─────────
  function setTheme(th) { document.documentElement.dataset.theme = th; localStorage.setItem('admin_theme', th); }
  setTheme(localStorage.getItem('admin_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  // ───────── session + api ─────────
  const getToken = () => sessionStorage.getItem('admin_token') || '';
  const setToken = (tk) => { tk ? sessionStorage.setItem('admin_token', tk) : sessionStorage.removeItem('admin_token'); };
  async function api(path, body) {
    const r = await fetch(WORKER + '/admin/' + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
      body: JSON.stringify(body || {}),
    });
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (r.status === 401 && path !== 'login' && path !== 'bootstrap') { setToken(''); render(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(data.error || ('http_' + r.status));
    return data;
  }
  function toast(msg, bad) {
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    document.body.append(el); requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 2400);
  }

  // ───────── LOGIN ─────────
  function renderLogin() {
    let bootMode = false;
    const errEl = h('div', { class: 'login-err' });
    const email = h('input', { type: 'email', autocomplete: 'username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' });
    const adminKey = h('input', { type: 'password' });
    const akField = h('div', { class: 'field', style: 'display:none' }, h('label', null, t('admin_key')), adminKey);
    const submitBtn = h('button', { class: 'btn btn--primary', style: 'width:100%', type: 'submit' }, t('login'));
    const bootLink = h('a', { href: '#', onclick: (e) => { e.preventDefault(); bootMode = !bootMode; akField.style.display = bootMode ? '' : 'none'; submitBtn.textContent = bootMode ? t('create_owner') : t('login'); } }, t('bootstrap'));

    async function submit(e) {
      e.preventDefault(); errEl.textContent = ''; submitBtn.disabled = true;
      try {
        if (bootMode) {
          await api('bootstrap', { email: email.value.trim(), password: pass.value, admin_key: adminKey.value });
          toast(t('saved')); bootMode = false; akField.style.display = 'none'; submitBtn.textContent = t('login');
        } else {
          const r = await api('login', { email: email.value.trim(), password: pass.value, totp: totp.value.trim() });
          setToken(r.token); render();
        }
      } catch (err) {
        errEl.textContent = t('error') + ': ' + err.message;
      } finally { submitBtn.disabled = false; }
    }
    const form = h('form', { class: 'login-card', onsubmit: submit },
      h('div', { class: 'login-logo' }, '🐾 ' + t('brand')),
      h('div', { class: 'login-sub' }, t('login_sub')),
      h('div', { class: 'field' }, h('label', null, t('email')), email),
      h('div', { class: 'field' }, h('label', null, t('password')), pass),
      h('div', { class: 'field' }, h('label', null, t('totp')), totp),
      akField, errEl, submitBtn,
      h('div', { class: 'login-foot' }, bootLink, h('span', null,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); setLang(lang === 'vi' ? 'de' : 'vi'); } }, lang === 'vi' ? 'DE' : 'VI'),
        ' · ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); } }, '◐'))));
    clear(app).append(h('div', { class: 'login' }, form));
  }

  // ───────── APP SHELL ─────────
  let currentPage = (location.hash || '#dashboard').slice(1);
  const PAGES = {
    dashboard: { icon: '📊', label: 'nav_dash', render: pageDashboard },
    system: { icon: '⚙️', label: 'nav_system', render: pageSystem },
    users: { icon: '👥', label: 'nav_users', render: pageUsers },
    payments: { icon: '💳', label: 'nav_pay', render: pagePayments },
  };
  function renderShell() {
    const nav = Object.keys(PAGES).map((k) => h('button', {
      class: 'nav-item' + (k === currentPage ? ' on' : ''), onclick: () => { currentPage = k; location.hash = k; route(); closeSidebar(); },
    }, h('span', { class: 'nav-ico' }, PAGES[k].icon), t(PAGES[k].label)));
    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'brand' }, '🐾 ', t('brand')),
      ...nav,
      h('div', { class: 'sidebar-foot' },
        h('button', { class: 'nav-item', onclick: () => setLang(lang === 'vi' ? 'de' : 'vi') }, h('span', { class: 'nav-ico' }, '🌐'), t('lang') + ': ' + lang.toUpperCase()),
        h('button', { class: 'nav-item', onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, h('span', { class: 'nav-ico' }, '◐'), t('theme')),
        h('button', { class: 'nav-item', onclick: doLogout }, h('span', { class: 'nav-ico' }, '🚪'), t('logout'))));
    const view = h('div', { class: 'view', id: 'view' });
    const topbar = h('header', { class: 'topbar' },
      h('button', { class: 'btn btn--ghost burger', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, '☰'),
      h('h1', { id: 'page-title' }, t(PAGES[currentPage].label)));
    clear(app).append(h('div', { class: 'shell' }, sidebar, h('main', { class: 'main' }, topbar, view)));
    route();
  }
  function closeSidebar() { const s = document.getElementById('sidebar'); if (s) s.classList.remove('open'); }
  async function doLogout() { try { await api('logout', {}); } catch (_) {} setToken(''); render(); }
  function setActiveNav() {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('on'));
    const idx = Object.keys(PAGES).indexOf(currentPage);
    const items = document.querySelectorAll('.sidebar .nav-item');
    if (items[idx]) items[idx].classList.add('on');
    const tt = document.getElementById('page-title'); if (tt) tt.textContent = t(PAGES[currentPage].label);
  }
  async function route() {
    setActiveNav();
    const view = document.getElementById('view'); if (!view) return;
    clear(view).append(h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' ', t('loading')));
    try { await PAGES[currentPage].render(view); }
    catch (err) { clear(view).append(h('div', { class: 'empty' }, t('error') + ': ' + err.message)); }
  }

  // ───────── helpers ─────────
  function bar(used, total, klass) {
    const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
    return h('div', { class: 'bar' + (pct >= 90 ? ' bar--bad' : pct >= 70 ? ' bar--warn' : '') + (klass ? ' ' + klass : '') }, h('i', { style: 'width:' + pct + '%' }));
  }
  function planBadge(plan) { const p = (plan || 'free').toLowerCase(); return h('span', { class: 'badge badge--' + (p === 'free' ? 'free' : 'pro') }, plan || 'free'); }

  // ───────── PAGE: Dashboard ─────────
  async function pageDashboard(view) {
    const s = await api('stats/overview', {});
    const cards = h('div', { class: 'cards' },
      kpi(t('total_users'), fmt(s.totalUsers), '+' + fmt(s.newUsers30) + ' / 30d'),
      kpi(t('api_keys'), fmt(s.keys.active) + ' ' + t('keys_active'), fmt(s.keys.exhausted) + ' ' + t('keys_exhausted')),
      kpi(t('paid_count'), fmt(s.paidCount), Object.keys(s.revenue || {}).map((c) => fmt(s.revenue[c]) + ' ' + c).join(' · ') || '—'),
      kpi(t('credits_req'), fmt(s.credits.reqUsed) + ' / ' + fmt(s.credits.reqTotal), ''));
    function kpi(label, val, sub) { return h('div', { class: 'card' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-val' }, val), h('div', { class: 'kpi-sub' }, sub)); }

    const plans = h('div', { class: 'panel' }, h('h2', null, t('plan_dist')));
    const totalP = Object.values(s.planDist || {}).reduce((a, b) => a + b, 0) || 1;
    Object.keys(s.planDist || {}).forEach((p) => {
      plans.append(h('div', null, h('div', { class: 'dist-row' }, h('span', null, p), h('span', null, fmt(s.planDist[p]))), bar(s.planDist[p], totalP)));
    });
    const credits = h('div', { class: 'panel' }, h('h2', null, t('api_keys')),
      h('div', { class: 'dist-row' }, h('span', null, t('credits_req')), h('span', null, fmt(s.credits.reqUsed) + ' / ' + fmt(s.credits.reqTotal))), bar(s.credits.reqUsed, s.credits.reqTotal),
      h('div', { class: 'dist-row' }, h('span', null, t('credits_tok')), h('span', null, fmt(s.credits.tokUsed) + ' / ' + fmt(s.credits.tokTotal))), bar(s.credits.tokUsed, s.credits.tokTotal));

    const audit = h('div', { class: 'panel' }, h('h2', null, t('audit')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    clear(view).append(cards, h('div', { class: 'grid2' }, plans, credits), audit);
    try {
      const a = await api('audit/list', {});
      const tb = h('table', null, h('thead', null, h('tr', null, h('th', null, 'time'), h('th', null, 'action'), h('th', null, 'target'), h('th', null, 'ip'))));
      const body = h('tbody');
      (a.items || []).slice(0, 30).forEach((r) => body.append(h('tr', null, h('td', null, fmtDate(r.created_at)), h('td', null, r.action), h('td', null, (r.target_type || '') + ' ' + (r.target_id || '')), h('td', null, r.ip || ''))));
      clear(audit).append(h('h2', null, t('audit')), h('div', { class: 'table-wrap' }, tb.appendChild(body) && tb));
    } catch (_) { clear(audit).append(h('h2', null, t('audit')), h('div', { class: 'empty' }, '—')); }
  }

  // ───────── PAGE: System ─────────
  async function pageSystem(view) {
    clear(view);
    // Health
    const healthPanel = h('div', { class: 'panel' }, h('h2', null, t('health')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    // Keys
    const keysPanel = h('div', { class: 'panel' }, h('h2', null, t('api_keys')));
    const provPanel = h('div', { class: 'panel' }, h('h2', null, t('providers')));
    const addPanel = h('div', { class: 'panel' }, h('h2', null, t('add_key')));
    const transPanel = h('div', { class: 'panel' }, h('h2', null, t('trans_settings')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    view.append(healthPanel, transPanel, h('div', { class: 'grid2' }, keysPanel, provPanel), addPanel);

    const [health, keys, provs, transCfg] = await Promise.all([api('health', {}), api('keys/list', {}), api('providers/list', {}), api('settings/translation/get', {})]);

    // health render
    const dot = (ok) => h('span', { class: 'health-dot ' + (ok ? 'ok' : 'bad') });
    const hp = h('div', { class: 'panel-row' },
      h('div', null, dot(health.worker && health.worker.ok), t('worker')),
      h('div', null, dot(health.supabase && health.supabase.ok), 'Supabase'),
      h('div', null, h('span', { class: 'badge badge--free' }, t('groq_env') + ': ' + (health.groqEnvKeys || 0))),
      h('div', null, h('span', { class: 'badge ' + (health.deepl ? 'badge--good' : 'badge--free') }, 'DeepL ' + (health.deepl ? '✓' : '✗'))),
      h('div', null, h('span', { class: 'badge ' + (health.openrouter ? 'badge--good' : 'badge--free') }, 'OpenRouter ' + (health.openrouter ? '✓' : '✗'))));
    clear(healthPanel).append(h('h2', null, t('health')), hp);

    // keys table
    function renderKeys(items) {
      const tb = h('table', null, h('thead', null, h('tr', null,
        h('th', null, t('provider')), h('th', null, t('label')), h('th', null, t('status')),
        h('th', null, t('requests')), h('th', null, t('tokens')), h('th', null, t('actions')))));
      const body = h('tbody');
      (items || []).forEach((k) => {
        const reqCell = h('td', null, fmt(k.credit_requests_used) + ' / ' + fmt(k.credit_requests_total), bar(k.credit_requests_used, k.credit_requests_total));
        const tokCell = h('td', null, fmt(k.credit_tokens_used) + ' / ' + fmt(k.credit_tokens_total), bar(k.credit_tokens_used, k.credit_tokens_total));
        const statusBadge = h('span', { class: 'badge ' + (k.status === 'active' ? 'badge--good' : k.status === 'exhausted' ? 'badge--warn' : 'badge--bad') }, k.status);
        const actions = h('td', null, h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn--sm', onclick: async () => {
            const rq = parseInt(prompt(t('add_credit_req'), '0') || '0', 10);
            const tk = parseInt(prompt(t('add_credit_tok'), '0') || '0', 10);
            if (!rq && !tk) return;
            await api('keys/credit', { id: k.id, add_requests: rq, add_tokens: tk }); toast(t('saved')); route();
          } }, t('add_credit')),
          h('button', { class: 'btn btn--sm', onclick: async () => { await api('keys/disable', { id: k.id }); toast(t('saved')); route(); } }, t('disable')),
          h('button', { class: 'btn btn--sm btn--danger', onclick: async () => { if (confirm(t('confirm_delete'))) { await api('keys/delete', { id: k.id }); toast(t('saved')); route(); } } }, t('delete'))));
        body.append(h('tr', null, h('td', null, k.provider_id), h('td', null, k.label || '—'), h('td', null, statusBadge), reqCell, tokCell, actions));
      });
      tb.append(body);
      clear(keysPanel).append(h('h2', null, t('api_keys')), (items && items.length) ? h('div', { class: 'table-wrap' }, tb) : h('div', { class: 'empty' }, '—'));
    }
    renderKeys(keys.items);

    // translation default (provider cho gói trả phí + nguồn gói free)
    {
      const TRANS_PROVS = ['gemini', 'deepl', 'openrouter', 'mistral'];
      const tv = transCfg.value || { paid_provider: 'gemini', free_source: 'free' };
      const provOpts = (transCfg.providers || []).filter((p) => TRANS_PROVS.includes(p.id));
      const list = provOpts.length ? provOpts : TRANS_PROVS.map((id) => ({ id, display_name: id }));
      const paidSel = h('select', null, ...list.map((p) => h('option', { value: p.id, selected: tv.paid_provider === p.id ? 'selected' : null }, p.display_name + (p.enabled === false ? ' (tắt)' : ''))));
      const freeSel = h('select', null,
        h('option', { value: 'free', selected: (tv.free_source || 'free') === 'free' ? 'selected' : null }, t('trans_free_youtube')),
        ...list.map((p) => h('option', { value: p.id, selected: tv.free_source === p.id ? 'selected' : null }, p.display_name)));
      clear(transPanel).append(
        h('h2', null, t('trans_settings')),
        h('div', { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', null, t('trans_paid_provider')), paidSel),
          h('div', { class: 'field' }, h('label', null, t('trans_free_source')), freeSel)),
        h('div', { class: 'muted', style: 'margin:8px 0' }, t('trans_note')),
        h('button', { class: 'btn btn--primary', onclick: async () => {
          await api('settings/translation/set', { paid_provider: paidSel.value, free_source: freeSel.value });
          toast(t('saved'));
        } }, t('save')));
    }

    // providers
    const pv = h('div');
    (provs.items || []).forEach((p) => {
      pv.append(h('div', { class: 'panel-row', style: 'justify-content:space-between;border-bottom:1px solid var(--border);padding:8px 0' },
        h('div', null, h('b', null, p.display_name), p.kind === 'session' ? h('div', { class: 'muted' }, '⚠️ ' + t('session_warning')) : (p.risk_note ? h('div', { class: 'muted' }, p.risk_note) : null)),
        h('button', { class: 'btn btn--sm ' + (p.enabled ? 'btn--primary' : ''), onclick: async () => { await api('providers/toggle', { id: p.id, enabled: !p.enabled }); toast(t('saved')); route(); } }, p.enabled ? t('enabled') : t('disable'))));
    });
    clear(provPanel).append(h('h2', null, t('providers')), pv);

    // add key form
    const provSel = h('select', null, ...(provs.items || []).map((p) => h('option', { value: p.id }, p.display_name)));
    const labelI = h('input', { type: 'text', placeholder: 'e.g. Gemini #1' });
    const secretI = h('input', { type: 'password', placeholder: 'API key' });
    const reqI = h('input', { type: 'number', value: '0' });
    const tokI = h('input', { type: 'number', value: '0' });
    const prioI = h('input', { type: 'number', value: '100' });
    const intSel = h('select', null, h('option', { value: 'none' }, t('interval_none')), h('option', { value: 'daily' }, t('interval_daily')), h('option', { value: 'weekly' }, t('interval_weekly')));
    clear(addPanel).append(h('h2', null, t('add_key')),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, t('provider')), provSel),
        h('div', { class: 'field' }, h('label', null, t('label')), labelI),
        h('div', { class: 'field' }, h('label', null, t('secret')), secretI),
        h('div', { class: 'field' }, h('label', null, t('priority')), prioI),
        h('div', { class: 'field' }, h('label', null, t('requests') + ' (+)'), reqI),
        h('div', { class: 'field' }, h('label', null, t('tokens') + ' (+)'), tokI),
        h('div', { class: 'field' }, h('label', null, t('reset_interval')), intSel)),
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        if (!secretI.value) return;
        await api('keys/add', { provider_id: provSel.value, label: labelI.value, secret: secretI.value, credit_requests_total: +reqI.value || 0, credit_tokens_total: +tokI.value || 0, priority: +prioI.value || 100, reset_interval: intSel.value });
        toast(t('saved')); route();
      } }, t('add'))));
  }

  // ───────── PAGE: Users ─────────
  async function pageUsers(view) {
    clear(view);
    const searchI = h('input', { type: 'search', placeholder: t('search_user'), style: 'max-width:320px' });
    const panel = h('div', { class: 'panel' });
    view.append(h('div', { class: 'panel-row' }, searchI, h('button', { class: 'btn', onclick: load }, '🔍')), panel);
    let timer;
    searchI.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });
    async function load() {
      clear(panel).append(h('div', { class: 'empty' }, h('span', { class: 'spin' })));
      const r = await api('users/list', { q: searchI.value.trim() });
      const tb = h('table', null, h('thead', null, h('tr', null,
        h('th', null, t('email')), h('th', null, t('plan')), h('th', null, t('model_source')), h('th', null, t('trans_provider')), h('th', null, t('created')), h('th', null, t('actions')))));
      const body = h('tbody');
      const TRANS_PROVS = ['gemini', 'deepl', 'openrouter', 'mistral'];
      (r.items || []).forEach((u) => {
        const planSel = h('select', { class: 'select-inline', onchange: async (e) => { await api('users/set-plan', { user_id: u.id, plan: e.target.value }); toast(t('saved')); } },
          ...['free', 'basic', 'pro', 'lifetime'].map((p) => h('option', { value: p, selected: (u.plan || 'free') === p ? 'selected' : null }, p)));
        const srcSel = h('select', { class: 'select-inline', onchange: async (e) => { await api('users/model-source', { user_id: u.id, model_source: e.target.value }); toast(t('saved')); } },
          ...[['server', t('src_server')], ['local', t('src_local')], ['dedicated', t('src_dedicated')]].map((o) => h('option', { value: o[0], selected: (u.model_source || 'server') === o[0] ? 'selected' : null }, o[1])));
        // API dịch cho riêng user (rỗng = theo hệ thống) + ép dịch API kể cả gói free.
        const transSel = h('select', { class: 'select-inline', onchange: async (e) => { await api('users/translation', { user_id: u.id, translation_provider: e.target.value }); toast(t('saved')); } },
          h('option', { value: '', selected: !u.translation_provider ? 'selected' : null }, t('trans_default_sys')),
          ...TRANS_PROVS.map((p) => h('option', { value: p, selected: u.translation_provider === p ? 'selected' : null }, p)));
        const premBox = h('input', { type: 'checkbox', title: t('premium_translate'), checked: u.premium_translate ? 'checked' : null, onchange: async (e) => { await api('users/translation', { user_id: u.id, premium_translate: e.target.checked }); toast(t('saved')); } });
        const banBtn = h('button', { class: 'btn btn--sm', onclick: async () => { await api('users/' + (u.banned ? 'unban' : 'ban'), { user_id: u.id }); toast(t('saved')); load(); } }, u.banned ? t('unban') : t('ban'));
        const delBtn = h('button', { class: 'btn btn--sm btn--danger', onclick: async () => { if (confirm(t('confirm_delete'))) { await api('users/delete', { user_id: u.id }); toast(t('saved')); load(); } } }, t('delete'));
        body.append(h('tr', null,
          h('td', null, u.banned ? h('span', { class: 'badge badge--bad' }, t('banned') + ' ') : null, u.email || u.id),
          h('td', null, planSel), h('td', null, srcSel),
          h('td', null, h('div', { class: 'panel-row', style: 'gap:6px' }, transSel, h('label', { class: 'muted', style: 'display:flex;align-items:center;gap:3px;font-size:11px' }, premBox, t('premium_translate')))),
          h('td', null, fmtDate(u.created_at)),
          h('td', null, h('div', { class: 'row-actions' }, banBtn, delBtn))));
      });
      tb.append(body);
      clear(panel).append((r.items && r.items.length) ? h('div', { class: 'table-wrap' }, tb) : h('div', { class: 'empty' }, '—'));
    }
    await load();
  }

  // ───────── PAGE: Payments ─────────
  async function pagePayments(view) {
    clear(view);
    const cfgPanel = h('div', { class: 'panel' }, h('h2', null, t('payout_cfg')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    const orderPanel = h('div', { class: 'panel' }, h('h2', null, t('create_order')));
    const listPanel = h('div', { class: 'panel' }, h('h2', null, t('orders')));
    view.append(cfgPanel, h('div', { class: 'grid2' }, orderPanel, listPanel));

    const { config } = await api('payout-config/get', {});
    const c = config || {};
    const fields = {
      beneficiary_name: h('input', { type: 'text', value: c.beneficiary_name || '' }),
      iban: h('input', { type: 'text', value: c.iban || '' }),
      bic: h('input', { type: 'text', value: c.bic || '' }),
      bank_name: h('input', { type: 'text', value: c.bank_name || '' }),
      paypal_link: h('input', { type: 'text', value: c.paypal_link || '' }),
      sepay_account_number: h('input', { type: 'text', value: c.sepay_account_number || '' }),
      sepay_bank_code: h('input', { type: 'text', value: c.sepay_bank_code || '' }),
      iban_ref_prefix: h('input', { type: 'text', value: c.iban_ref_prefix || 'DE-' }),
      sepay_ref_prefix: h('input', { type: 'text', value: c.sepay_ref_prefix || 'VN-' }),
      price_table: h('textarea', { rows: '4' }, JSON.stringify(c.price_table || {}, null, 2)),
    };
    const labels = { beneficiary_name: 'beneficiary', iban: 'iban', bic: 'bic', bank_name: 'bank', paypal_link: 'paypal', sepay_account_number: 'sepay_acc', sepay_bank_code: 'sepay_bank', iban_ref_prefix: 'iban_prefix', sepay_ref_prefix: 'sepay_prefix', price_table: 'price_table' };
    const grid = h('div', { class: 'form-grid' });
    Object.keys(fields).forEach((k) => grid.append(h('div', { class: 'field' + (k === 'price_table' ? '' : '') }, h('label', null, t(labels[k])), fields[k])));
    clear(cfgPanel).append(h('h2', null, t('payout_cfg')), grid,
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        const payload = {};
        Object.keys(fields).forEach((k) => { payload[k] = k === 'price_table' ? safeJson(fields[k].value) : fields[k].value; });
        await api('payout-config/update', payload); toast(t('saved'));
      } }, t('save'))));
    function safeJson(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

    // create order
    const oUser = h('input', { type: 'text', placeholder: 'uuid' });
    const oMethod = h('select', null, h('option', { value: 'iban' }, 'IBAN (DE)'), h('option', { value: 'sepay' }, 'SePay (VN)'), h('option', { value: 'paypal' }, 'PayPal'));
    const oPlan = h('select', null, ...['basic', 'pro', 'lifetime'].map((p) => h('option', { value: p }, p)));
    const oAmount = h('input', { type: 'number', value: '0' });
    const oCur = h('select', null, h('option', { value: 'EUR' }, 'EUR'), h('option', { value: 'VND' }, 'VND'));
    const oOut = h('div');
    clear(orderPanel).append(h('h2', null, t('create_order')),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', null, t('user_id_opt')), oUser),
        h('div', { class: 'field' }, h('label', null, t('method')), oMethod),
        h('div', { class: 'field' }, h('label', null, t('plan')), oPlan),
        h('div', { class: 'field' }, h('label', null, t('amount')), oAmount),
        h('div', { class: 'field' }, h('label', null, t('currency')), oCur)),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn btn--primary', onclick: async () => {
        const r = await api('payments/create-order', { user_id: oUser.value.trim(), method: oMethod.value, plan: oPlan.value, amount: +oAmount.value || 0, currency: oCur.value });
        const ins = r.instructions || {};
        clear(oOut).append(h('div', { class: 'note' },
          h('div', null, t('ref_code') + ': ', h('code', null, r.reference_code)),
          h('div', { style: 'margin-top:6px' }, t('order_instructions') + ':'),
          h('pre', { style: 'white-space:pre-wrap;margin:6px 0 0' }, Object.keys(ins).map((k) => k + ': ' + ins[k]).join('\n'))));
        toast(t('saved')); loadOrders();
      } }, t('create_order'))), oOut);

    // orders list
    async function loadOrders() {
      clear(listPanel).append(h('h2', null, t('orders')), h('div', { class: 'empty' }, h('span', { class: 'spin' })));
      const r = await api('payments/list', {});
      const tb = h('table', null, h('thead', null, h('tr', null, h('th', null, t('ref_code')), h('th', null, t('method')), h('th', null, t('plan')), h('th', null, t('amount')), h('th', null, t('status')), h('th', null, t('actions')))));
      const body = h('tbody');
      (r.items || []).forEach((p) => {
        const st = h('span', { class: 'badge ' + (p.status === 'paid' ? 'badge--good' : 'badge--warn') }, p.status === 'paid' ? t('paid') : t('pending'));
        const act = p.status === 'paid' ? h('span', { class: 'muted' }, fmtDate(p.paid_at)) : h('button', { class: 'btn btn--sm btn--primary', onclick: async () => { await api('payments/mark-paid', { id: p.id }); toast(t('saved')); loadOrders(); } }, t('mark_paid'));
        body.append(h('tr', null, h('td', null, p.reference_code), h('td', null, p.method), h('td', null, p.plan || '—'), h('td', null, fmt(p.amount) + ' ' + p.currency), h('td', null, st), h('td', null, act)));
      });
      tb.append(body);
      clear(listPanel).append(h('h2', null, t('orders')), (r.items && r.items.length) ? h('div', { class: 'table-wrap' }, tb) : h('div', { class: 'empty' }, '—'));
    }
    await loadOrders();
  }

  // ───────── boot ─────────
  function render() { if (getToken()) renderShell(); else renderLogin(); }
  window.addEventListener('hashchange', () => { const p = (location.hash || '#dashboard').slice(1); if (PAGES[p]) { currentPage = p; if (getToken()) route(); } });
  render();
})();
