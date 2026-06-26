/* video-subs.js — Phụ đề SONG NGỮ hiện TRÊN video (YouTube/Netflix) như Language Reactor.
 * - Gộp phụ đề gốc + bản dịch thành MỘT khối (không tách 2 thanh).
 * - Ẩn phụ đề gốc của trình phát khi overlay BẬT (tránh trùng 2 thanh sub).
 * - Thiếu bản dịch (YouTube không có tlang) -> nhờ background dịch (Microsoft -> Google -> MyMemory).
 * - Nút BẬT/TẮT giống Language Reactor trong thanh điều khiển YouTube, dùng logo của bạn. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};

  function start() {
    const SD = root.SD;
    if (!SD.engine) return setTimeout(start, 500);

    // ===== Style: overlay (1 khối gộp) + ẩn phụ đề gốc khi overlay bật + nút toggle =====
    const st = document.createElement('style');
    st.id = 'sd-vsubs-style';
    st.textContent =
      '#sd-vsubs{position:absolute;left:0;right:0;bottom:11%;text-align:center;z-index:60;display:none;padding:0 6%;pointer-events:none}' +
      '#sd-vsubs .sd-sub-card{display:inline-block;max-width:96%;background:rgba(0,0,0,.80);border-radius:10px;padding:6px 14px;box-shadow:0 2px 14px rgba(0,0,0,.45);animation:sdSubIn .18s ease}' +
      '#sd-vsubs .sd-sub-de{color:#fff;font-size:26px;font-weight:700;line-height:1.32}' +
      '#sd-vsubs .sd-sub-tr{color:#ffd966;font-size:18px;line-height:1.3;margin-top:2px}' +
      '@keyframes sdSubIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
      /* Ẩn phụ đề gốc của YouTube/Netflix khi overlay BẬT -> chỉ còn 1 thanh sub */
      'html.sd-hide-native .ytp-caption-window-container,' +
      'html.sd-hide-native .caption-window,' +
      'html.sd-hide-native .player-timedtext{opacity:0 !important;visibility:hidden !important;pointer-events:none !important}' +
      /* Khối điều khiển trong thanh YouTube: logo (mở panel) + chip BẬT/TẮT (master) */
      '#sd-toggle-btn.sd-toggle-btn{display:inline-flex !important;align-items:center;justify-content:center;gap:6px;width:auto !important;padding:0 8px;vertical-align:top}' +
      '#sd-toggle-btn .sd-toggle-logo{width:22px;height:22px;border-radius:50%;object-fit:cover;cursor:pointer;opacity:.95;transition:transform .15s,filter .15s,opacity .15s}' +
      '#sd-toggle-btn .sd-toggle-logo:hover{transform:scale(1.14);opacity:1}' +
      '#sd-toggle-btn .sd-toggle-state{cursor:pointer;color:#fff;font-size:11px;font-weight:700;letter-spacing:.5px;padding:2px 6px;border-radius:9px;background:rgba(120,170,255,.28);transition:background .15s,color .15s}' +
      '#sd-toggle-btn .sd-toggle-state:hover{background:rgba(120,170,255,.45)}' +
      '#sd-toggle-btn.sd-off .sd-toggle-logo{filter:grayscale(1) opacity(.55)}' +
      '#sd-toggle-btn.sd-off .sd-toggle-state{color:#9aa0a6;background:rgba(150,150,150,.22)}';
    document.documentElement.appendChild(st);

    const ov = document.createElement('div'); ov.id = 'sd-vsubs';
    ov.innerHTML = '<div class="sd-sub-card"><div class="sd-sub-de"></div><div class="sd-sub-tr"></div></div>';

    function attach() {
      const p = document.querySelector('.html5-video-player') || document.querySelector('#movie_player') ||
        document.querySelector('[data-uia="player"]') || document.querySelector('.watch-video');
      if (p && ov.parentElement !== p) p.appendChild(ov);
    }
    attach(); setInterval(attach, 2000);

    // Hai cờ tách biệt:
    //  - extEnabled: MASTER ON/OFF (chip trong trình phát). OFF = tắt hẳn extension trên video này.
    //  - subsOn: tùy chọn "Phụ đề trên video" trong cài đặt (chỉ bật/tắt overlay khi master ON).
    let extEnabled = !(SD.engine.settings && SD.engine.settings.extEnabled === false);
    let subsOn = !(SD.engine.settings && SD.engine.settings.videoSubs === false);
    let lastSentence = null;
    function overlayActive() { return extEnabled && subsOn; }
    // CHỈ ẩn phụ đề gốc khi overlay ĐANG hiện câu — nếu chưa tải được phụ đề thì
    // vẫn để phụ đề gốc của trình phát hiển thị (không bỏ trắng màn hình).
    function applyNativeHide() {
      document.documentElement.classList.toggle('sd-hide-native', overlayActive() && !!lastSentence);
    }
    applyNativeHide();
    function render(s) {
      const de = ov.querySelector('.sd-sub-de');
      const tr = ov.querySelector('.sd-sub-tr');
      if (de) de.textContent = s.text || '';
      if (tr) {
        if (s.trans) { tr.textContent = s.trans; tr.style.display = ''; }
        else { tr.textContent = ''; tr.style.display = 'none'; ensureTrans(s); }
      }
      ov.style.display = 'block';
    }

    SD.engine.listen('current', (c) => {
      const s = c.sentence; lastSentence = s;
      if (!s || !overlayActive()) { ov.style.display = 'none'; applyNativeHide(); return; }
      render(s);
      applyNativeHide();
    });

    // ===== Dịch bổ sung khi thiếu bản dịch (ưu tiên YouTube tlang đã gán lúc fetch;
    // nếu thiếu -> nhờ background: Microsoft -> Google -> MyMemory). =====
    const transReq = {};
    function ensureTrans(s) {
      if (!s || s.trans || transReq[s.text]) return;
      transReq[s.text] = true;
      const cfg = (SD.engine && SD.engine.settings) || {};
      const from = cfg.targetLang || 'de';
      const to = cfg.nativeLang || 'vi';
      try {
        chrome.runtime.sendMessage({ sd: 'translate', text: s.text, from, to }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.ok && res.text) {
            s.trans = res.text;
            if (overlayActive() && lastSentence === s) {
              const tr = ov.querySelector('.sd-sub-tr');
              if (tr) { tr.textContent = res.text; tr.style.display = ''; }
            }
          }
        });
      } catch (e) {}
    }

    // Áp dụng trạng thái master + overlay rồi cập nhật giao diện.
    function applyState() {
      applyNativeHide();
      if (!overlayActive()) ov.style.display = 'none';
      else if (lastSentence) render(lastSentence);
      updateToggleBtn();
    }

    // API cho cs-api:
    //  - show(b): tùy chọn "Phụ đề trên video" (overlay) trong cài đặt.
    //  - setMaster(b): master ON/OFF (đồng bộ khi side panel đổi extEnabled).
    SD.videoSubs = {
      show: (b) => { subsOn = !!b; applyState(); },
      setMaster: (b) => { extEnabled = !!b; applyState(); },
      isEnabled: () => overlayActive(),
      isMaster: () => extEnabled,
    };

    // Bật/tắt MASTER từ chip trong trình phát: tắt hẳn auto-pause/loop + overlay, lưu lại.
    function setMasterFromUI(on) {
      extEnabled = !!on;
      try { if (SD.engine.setEnabled) SD.engine.setEnabled(extEnabled); } catch (e) {}
      try { if (SD.storage) SD.storage.saveSettings({ extEnabled }); } catch (e) {}
      if (SD.engine.settings) SD.engine.settings.extEnabled = extEnabled;
      applyState();
    }

    // Cài đặt có thể được nạp sau khi start() chạy (main.js load async) -> đồng bộ lại
    // cờ master/overlay từ storage để chip & engine phản ánh đúng trạng thái đã lưu.
    try {
      if (SD.storage) SD.storage.get().then((d) => {
        const cfg = (d && d.settings) || {};
        extEnabled = cfg.extEnabled !== false;
        subsOn = cfg.videoSubs !== false;
        try { if (SD.engine.setEnabled) SD.engine.setEnabled(extEnabled); } catch (e) {}
        applyState();
      });
    } catch (e) {}

    // Đồng bộ realtime 2 chiều: side panel hoặc tab khác đổi master/overlay → cập nhật
    // chip ON/OFF + overlay ngay (không ghi ngược lại nên không tạo vòng lặp).
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.sd_data_v1) return;
        const cfg = (changes.sd_data_v1.newValue && changes.sd_data_v1.newValue.settings) || null;
        if (!cfg) return;
        const newMaster = cfg.extEnabled !== false;
        const newSubs = cfg.videoSubs !== false;
        let changed = false;
        if (newMaster !== extEnabled) { extEnabled = newMaster; try { if (SD.engine.setEnabled) SD.engine.setEnabled(extEnabled); } catch (e) {} changed = true; }
        if (newSubs !== subsOn) { subsOn = newSubs; changed = true; }
        if (changed) applyState();
      });
    } catch (e) {}

    // ===== Khối điều khiển trong thanh YouTube: logo (mở panel) + chip BẬT/TẮT (master) =====
    function updateToggleBtn() {
      const btn = document.getElementById('sd-toggle-btn'); if (!btn) return;
      const stEl = btn.querySelector('.sd-toggle-state');
      if (stEl) stEl.textContent = extEnabled ? 'ON' : 'OFF';
      btn.classList.toggle('sd-off', !extEnabled);
    }
    function placeToggleBtn() {
      // Chỉ thêm trên YouTube (thanh .ytp-right-controls).
      const controls = document.querySelector('.ytp-right-controls');
      if (!controls || document.getElementById('sd-toggle-btn')) return;
      const btn = document.createElement('span');
      btn.id = 'sd-toggle-btn';
      btn.className = 'sd-toggle-btn';
      let logoUrl = '';
      try { logoUrl = chrome.runtime.getURL('icons/icon32.png'); } catch (e) {}
      btn.innerHTML =
        '<img class="sd-toggle-logo" src="' + logoUrl + '" alt="ND" title="NghienDeutsch — Mở bảng điều khiển">' +
        '<span class="sd-toggle-state" title="Bật/Tắt extension trên video này">ON</span>';
      // Logo: MỞ side panel (Language Reactor style).
      const logoEl = btn.querySelector('.sd-toggle-logo');
      if (logoEl) logoEl.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        try {
          chrome.runtime.sendMessage({ sd: 'openSidePanel' }, () => { if (chrome.runtime.lastError) {} });
        } catch (err) {}
      });
      // Chip ON/OFF: master switch.
      const stateEl = btn.querySelector('.sd-toggle-state');
      if (stateEl) stateEl.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        setMasterFromUI(!extEnabled);
      });
      controls.insertBefore(btn, controls.firstChild);
      updateToggleBtn();
    }
    placeToggleBtn();
    setInterval(placeToggleBtn, 2000);
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})(window);
