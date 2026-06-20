/**
 * ShadowEcho — Bộ báo lỗi nhẹ (client → Worker /log → Sentry tuỳ chọn).
 * Không phụ thuộc SDK nặng. Tự bắt window.onerror + unhandledrejection,
 * khử trùng lặp, giới hạn số lượng để không spam. Đọc CONFIG.WORKER_URL khi gửi.
 * Tải SAU config.js, TRƯỚC sidepanel.js.
 */
(function () {
  'use strict';
  const VERSION = '2.1.0';
  const MAX_PER_SESSION = 20;
  let sent = 0;
  const seen = new Set();

  function endpoint() {
    try { return (typeof CONFIG !== 'undefined' && CONFIG.WORKER_URL) ? CONFIG.WORKER_URL + '/log' : null; }
    catch (_) { return null; }
  }

  function report(level, message, stack, context, where) {
    try {
      const url = endpoint();
      if (!url || sent >= MAX_PER_SESSION) return;
      const msg = String(message || '').slice(0, 2000);
      const key = (where || '') + '|' + msg.slice(0, 120);
      if (seen.has(key)) return;       // khử trùng lặp cùng 1 lỗi
      seen.add(key); sent++;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level, message: msg, stack: String(stack || '').slice(0, 4000),
          context: context || {}, where: where || 'sidepanel', version: VERSION,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  self.addEventListener('error', (e) => {
    report('error', e.message || (e.error && e.error.message), e.error && e.error.stack,
      { src: e.filename, line: e.lineno, col: e.colno }, 'window.onerror');
  });
  self.addEventListener('unhandledrejection', (e) => {
    const r = e.reason || {};
    report('error', r.message || String(r), r.stack, {}, 'unhandledrejection');
  });

  // API thủ công cho các catch quan trọng: ShadowReport.error(err, ctx, where)
  self.ShadowReport = {
    report,
    error: (m, ctx, where) => report('error', (m && m.message) || m, m && m.stack, ctx, where),
    info: (m, ctx, where) => report('info', m, '', ctx, where),
  };
})();
