/* Speech proxy: microphone capture runs in the extension side panel. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  let onProgress = null;

  async function request(action, opts) {
    try {
      const response = await chrome.runtime.sendMessage({ sd: 'mic-service', action, opts: opts || {} });
      if (!response || !response.ok) throw new Error((response && response.error) || 'side-panel-unavailable');
      return response;
    } catch (error) {
      throw new Error('mic:' + (error.message || error));
    }
  }

  async function ensureMic() {
    // Ưu tiên cấp quyền NGAY trên trang (origin youtube.com) — không phải mở tab.
    if (root.SD.pageMic) { try { await root.SD.pageMic.ensure(); return true; } catch (e) { /* rơi xuống Side Panel */ } }
    await request('ensure'); return true;
  }
  function setProgress(cb) { onProgress = cb; }
  async function recognize(opts) {
    opts = opts || {};
    // Ghi âm NGAY trên trang nếu được (dùng quyền micro của youtube.com, không mở tab).
    // Lỗi (chưa cấp quyền / engine không hỗ trợ) -> rơi xuống ghi âm tại Side Panel.
    if (root.SD.pageMic && opts.usePageMic !== false && (opts.engine || 'whisper') !== 'server') {
      try { return await root.SD.pageMic.recognize(opts); }
      catch (e) {
        const m = (e && e.message) || String(e);
        if (/recording-aborted/.test(m)) return { error: m }; // user bấm Dừng -> tôn trọng
        // các lỗi khác -> thử lại bằng Side Panel bên dưới
      }
    }
    try { return (await request('recognize', opts)).result; }
    catch (error) {
      const message = error.message || String(error);
      if ((opts.engine || 'webspeech') === 'server') return { error: 'server-unavailable:' + message };
      if (opts.engine === 'whisper') return { error: 'whisper-unavailable:' + message };
      return { error: message };
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.sd === 'mic-progress' && onProgress) onProgress(msg.status, msg.pct);
  });
  root.SD.speech = { ensureMic, recognize, setProgress };
})(window);
