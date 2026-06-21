/* Bootstrap content script (ISOLATED): khoi tao engine + bridge + cau noi Side Panel.
 * Khong con overlay tren trang — UI nam o Chrome Side Panel. */
(function (root) {
  'use strict';
  function start() {
    if (window.__SD_BOOTED__) return;
    const SD = root.SD;
    if (!SD || !SD.engine || !SD.bridge || !SD.csapi || !SD.storage) return setTimeout(start, 400);
    window.__SD_BOOTED__ = true;
    SD.storage.get().then((d) => {
      SD.engine.setSettings(d.settings);
      SD.bridge.onSubtitles((s) => SD.engine.setSentences(s));
      SD.csapi.init();
      // Lần đầu cài extension: tự hiện hộp thoại xin quyền micro trên trang (1 lần).
      if (SD.pageMic && SD.pageMic.firstRunPrompt) SD.pageMic.firstRunPrompt();
    });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})(window);
