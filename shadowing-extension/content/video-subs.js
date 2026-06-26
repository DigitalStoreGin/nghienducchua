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
      '#sd-toggle-btn.sd-off .sd-toggle-state{color:#9aa0a6;background:rgba(150,150,150,.22)}' +
      /* Bánh răng ⚙ mở bảng tùy chọn phụ đề (Language Reactor style) */
      '#sd-toggle-btn .sd-toggle-gear{cursor:pointer;color:#fff;font-size:15px;line-height:1;padding:3px 4px;border-radius:8px;opacity:.9;transition:transform .15s,background .15s,opacity .15s}' +
      '#sd-toggle-btn .sd-toggle-gear:hover{transform:rotate(35deg) scale(1.12);opacity:1;background:rgba(255,255,255,.16)}' +
      /* Bảng tùy chọn (Optionen) — đè lên video, hiện trong cả chế độ toàn màn hình */
      '#sd-opt-panel{position:absolute;right:14px;bottom:62px;z-index:70;width:312px;max-width:86%;max-height:74%;overflow-y:auto;background:rgba(26,28,32,.97);color:#fff;border-radius:14px;padding:6px 14px 12px;box-shadow:0 10px 40px rgba(0,0,0,.55);font-family:Roboto,Arial,system-ui,sans-serif;display:none;backdrop-filter:blur(4px)}' +
      '#sd-opt-panel.sd-open{display:block;animation:sdSubIn .16s ease}' +
      '#sd-opt-panel .sd-opt-head{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:rgba(26,28,32,.98);padding:8px 0 6px;margin-bottom:2px}' +
      '#sd-opt-panel .sd-opt-title{font-size:14px;font-weight:700;letter-spacing:.2px}' +
      '#sd-opt-panel .sd-opt-close{cursor:pointer;font-size:18px;line-height:1;color:#bcc0c6;background:none;border:none;padding:2px 4px}' +
      '#sd-opt-panel .sd-opt-close:hover{color:#fff}' +
      '#sd-opt-panel .sd-opt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '#sd-opt-panel .sd-opt-row:last-child{border-bottom:none}' +
      '#sd-opt-panel .sd-opt-label{font-size:12.5px;color:#e8eaed;flex:0 0 auto}' +
      '#sd-opt-panel .sd-opt-val{font-size:12px;color:#9aa0a6;min-width:38px;text-align:right}' +
      '#sd-opt-panel select{background:#2c2f36;color:#fff;border:1px solid #44474e;border-radius:8px;padding:5px 8px;font-size:12.5px;cursor:pointer;max-width:170px}' +
      '#sd-opt-panel input[type=range]{flex:1;accent-color:#6c8cff;cursor:pointer;min-width:90px}' +
      '#sd-opt-panel input[type=color]{width:34px;height:26px;border:1px solid #44474e;border-radius:7px;background:none;cursor:pointer;padding:0}' +
      '#sd-opt-panel .sd-opt-reset{margin-top:10px;width:100%;background:rgba(255,255,255,.10);color:#fff;border:none;border-radius:9px;padding:8px;font-size:12.5px;cursor:pointer}' +
      '#sd-opt-panel .sd-opt-reset:hover{background:rgba(255,255,255,.18)}' +
      '#sd-opt-panel .sd-opt-ctl{display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end}';
    document.documentElement.appendChild(st);

    const ov = document.createElement('div'); ov.id = 'sd-vsubs';
    ov.innerHTML = '<div class="sd-sub-card"><div class="sd-sub-de"></div><div class="sd-sub-tr"></div></div>';

    // Style động cho phụ đề (đè base style — append sau nên thắng về độ ưu tiên).
    const dynSt = document.createElement('style'); dynSt.id = 'sd-vsubs-dynamic';
    document.documentElement.appendChild(dynSt);

    // Bảng tùy chọn phụ đề (build sau khi có settings) — đặt trong player để hiện cả khi fullscreen.
    const optPanel = document.createElement('div'); optPanel.id = 'sd-opt-panel';

    function attach() {
      const p = document.querySelector('.html5-video-player') || document.querySelector('#movie_player') ||
        document.querySelector('[data-uia="player"]') || document.querySelector('.watch-video');
      if (p && ov.parentElement !== p) p.appendChild(ov);
      if (p && optPanel.parentElement !== p) p.appendChild(optPanel);
    }
    attach(); setInterval(attach, 2000);

    // Hai cờ tách biệt:
    //  - extEnabled: MASTER ON/OFF (chip trong trình phát). OFF = tắt hẳn extension trên video này.
    //  - subsOn: tùy chọn "Phụ đề trên video" trong cài đặt (chỉ bật/tắt overlay khi master ON).
    let extEnabled = !(SD.engine.settings && SD.engine.settings.extEnabled === false);
    let subsOn = !(SD.engine.settings && SD.engine.settings.videoSubs === false);
    let lastSentence = null;
    function overlayActive() { return extEnabled && subsOn; }

    // ===== Kiểu phụ đề (Language Reactor "Optionen": font, màu, cỡ chữ, độ mờ) =====
    const SUBSTYLE_DEFAULT = { font: 'sans', deColor: '#ffffff', trColor: '#ffd966', sizePct: 100, bgColor: '#000000', bgOpacity: 0, winColor: '#000000', winOpacity: 80 };
    const FONT_STACKS = {
      sans: '"Roboto","Helvetica Neue",Arial,system-ui,sans-serif',
      serif: 'Georgia,"Times New Roman",serif',
      mono: '"Roboto Mono","Courier New",monospace',
      rounded: '"Nunito","Comic Sans MS",system-ui,sans-serif',
    };
    let subStyle = Object.assign({}, SUBSTYLE_DEFAULT, (SD.engine.settings && SD.engine.settings.subStyle) || {});
    function hexToRgba(hex, pct) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
      const n = m ? parseInt(m[1], 16) : 0;
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(100, pct)) / 100 + ')';
    }
    function applySubStyle() {
      const s = subStyle;
      const ff = FONT_STACKS[s.font] || FONT_STACKS.sans;
      const deSize = Math.round(26 * (s.sizePct || 100) / 100);
      const trSize = Math.round(18 * (s.sizePct || 100) / 100);
      const band = hexToRgba(s.bgColor, s.bgOpacity);
      dynSt.textContent =
        '#sd-vsubs .sd-sub-card{background:' + hexToRgba(s.winColor, s.winOpacity) + ';font-family:' + ff + '}' +
        '#sd-vsubs .sd-sub-de{color:' + s.deColor + ';font-size:' + deSize + 'px;' + (s.bgOpacity > 0 ? 'background:' + band + ';border-radius:6px;padding:1px 8px' : '') + '}' +
        '#sd-vsubs .sd-sub-tr{color:' + s.trColor + ';font-size:' + trSize + 'px;' + (s.bgOpacity > 0 ? 'background:' + band + ';border-radius:6px;padding:1px 8px;margin-top:3px' : '') + '}';
    }
    function saveSubStyle() {
      try { if (SD.storage) SD.storage.saveSettings({ subStyle }); } catch (e) {}
      if (SD.engine.settings) SD.engine.settings.subStyle = subStyle;
    }
    applySubStyle();

    // ===== Bảng tùy chọn phụ đề (Optionen) =====
    const OPT_LANGS = [
      ['vi', '🇻🇳 Tiếng Việt'], ['en', '🇬🇧 English'], ['fr', '🇫🇷 Français'], ['es', '🇪🇸 Español'],
      ['it', '🇮🇹 Italiano'], ['ru', '🇷🇺 Русский'], ['zh', '🇨🇳 中文'], ['ja', '🇯🇵 日本語'],
      ['ko', '🇰🇷 한국어'], ['ar', '🇸🇦 العربية'], ['tr', '🇹🇷 Türkçe'], ['pl', '🇵🇱 Polski'],
      ['id', '🇮🇩 Indonesia'], ['th', '🇹🇭 ไทย'], ['hi', '🇮🇳 हिन्दी'], ['uk', '🇺🇦 Українська'],
    ];
    const OPT_FONTS = [['sans', 'Không chân (Sans)'], ['serif', 'Có chân (Serif)'], ['mono', 'Đều nét (Mono)'], ['rounded', 'Bo tròn']];
    function optionsHtml(list, cur) {
      return list.map((x) => '<option value="' + x[0] + '"' + (x[0] === cur ? ' selected' : '') + '>' + x[1] + '</option>').join('');
    }
    function buildOptPanel() {
      const curNative = (SD.engine.settings && SD.engine.settings.nativeLang) || 'vi';
      const s = subStyle;
      optPanel.innerHTML =
        '<div class="sd-opt-head"><span class="sd-opt-title">⚙ Tùy chọn phụ đề</span><button class="sd-opt-close" title="Đóng">✕</button></div>' +
        // Ngôn ngữ dịch
        '<div class="sd-opt-row"><span class="sd-opt-label">Ngôn ngữ dịch</span><div class="sd-opt-ctl"><select data-k="nativeLang">' + optionsHtml(OPT_LANGS, curNative) + '</select></div></div>' +
        // Phông chữ
        '<div class="sd-opt-row"><span class="sd-opt-label">Phông chữ</span><div class="sd-opt-ctl"><select data-k="font">' + optionsHtml(OPT_FONTS, s.font) + '</select></div></div>' +
        // Cỡ chữ
        '<div class="sd-opt-row"><span class="sd-opt-label">Cỡ chữ</span><div class="sd-opt-ctl"><input type="range" min="60" max="200" step="5" data-k="sizePct" value="' + s.sizePct + '"><span class="sd-opt-val" data-v="sizePct">' + s.sizePct + '%</span></div></div>' +
        // Màu chữ
        '<div class="sd-opt-row"><span class="sd-opt-label">Màu chữ (gốc)</span><div class="sd-opt-ctl"><input type="color" data-k="deColor" value="' + s.deColor + '"></div></div>' +
        '<div class="sd-opt-row"><span class="sd-opt-label">Màu chữ (dịch)</span><div class="sd-opt-ctl"><input type="color" data-k="trColor" value="' + s.trColor + '"></div></div>' +
        // Nền chữ
        '<div class="sd-opt-row"><span class="sd-opt-label">Màu nền chữ</span><div class="sd-opt-ctl"><input type="color" data-k="bgColor" value="' + s.bgColor + '"></div></div>' +
        '<div class="sd-opt-row"><span class="sd-opt-label">Độ mờ nền chữ</span><div class="sd-opt-ctl"><input type="range" min="0" max="100" step="5" data-k="bgOpacity" value="' + s.bgOpacity + '"><span class="sd-opt-val" data-v="bgOpacity">' + s.bgOpacity + '%</span></div></div>' +
        // Khung
        '<div class="sd-opt-row"><span class="sd-opt-label">Màu khung</span><div class="sd-opt-ctl"><input type="color" data-k="winColor" value="' + s.winColor + '"></div></div>' +
        '<div class="sd-opt-row"><span class="sd-opt-label">Độ mờ khung</span><div class="sd-opt-ctl"><input type="range" min="0" max="100" step="5" data-k="winOpacity" value="' + s.winOpacity + '"><span class="sd-opt-val" data-v="winOpacity">' + s.winOpacity + '%</span></div></div>' +
        '<button class="sd-opt-reset">↺ Khôi phục mặc định</button>';

      optPanel.querySelector('.sd-opt-close').onclick = () => optPanel.classList.remove('sd-open');
      // Ngôn ngữ dịch: đổi → lưu + nạp lại bản dịch (YouTube tlang) cho ngôn ngữ mới.
      optPanel.querySelector('[data-k="nativeLang"]').onchange = (e) => {
        const to = e.target.value;
        if (SD.engine.settings) SD.engine.settings.nativeLang = to;
        try { if (SD.storage) SD.storage.saveSettings({ nativeLang: to }); } catch (_) {}
        for (const k in transReq) delete transReq[k];
        if (lastSentence) lastSentence.trans = '';
        try {
          if (location.hostname.includes('youtube') && SD.bridge && SD.bridge.fetchYouTubeTrack) {
            SD.bridge.fetchYouTubeTrack((SD.engine.settings && SD.engine.settings.targetLang) || 'de', to).catch(() => {});
          } else if (lastSentence) { ensureTrans(lastSentence); }
        } catch (_) { if (lastSentence) ensureTrans(lastSentence); }
      };
      // Phông chữ
      optPanel.querySelector('[data-k="font"]').onchange = (e) => { subStyle.font = e.target.value; applySubStyle(); saveSubStyle(); };
      // Các input color
      optPanel.querySelectorAll('input[type=color]').forEach((el) => {
        el.oninput = () => { subStyle[el.dataset.k] = el.value; applySubStyle(); };
        el.onchange = () => { subStyle[el.dataset.k] = el.value; applySubStyle(); saveSubStyle(); };
      });
      // Các slider (sizePct/bgOpacity/winOpacity)
      optPanel.querySelectorAll('input[type=range]').forEach((el) => {
        const lbl = optPanel.querySelector('[data-v="' + el.dataset.k + '"]');
        el.oninput = () => { subStyle[el.dataset.k] = +el.value; if (lbl) lbl.textContent = el.value + '%'; applySubStyle(); };
        el.onchange = () => { subStyle[el.dataset.k] = +el.value; saveSubStyle(); };
      });
      // Khôi phục mặc định
      optPanel.querySelector('.sd-opt-reset').onclick = () => { subStyle = Object.assign({}, SUBSTYLE_DEFAULT); applySubStyle(); saveSubStyle(); buildOptPanel(); optPanel.classList.add('sd-open'); };
    }
    function toggleOptPanel() {
      const open = !optPanel.classList.contains('sd-open');
      if (open) buildOptPanel();
      optPanel.classList.toggle('sd-open', open);
    }
    // Bấm ra ngoài → đóng panel.
    document.addEventListener('click', (e) => {
      if (!optPanel.classList.contains('sd-open')) return;
      if (optPanel.contains(e.target)) return;
      const gear = e.target.closest && e.target.closest('.sd-toggle-gear');
      if (gear) return;
      optPanel.classList.remove('sd-open');
    }, true);
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
        if (cfg.subStyle) { subStyle = Object.assign({}, SUBSTYLE_DEFAULT, cfg.subStyle); applySubStyle(); }
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
        // Đồng bộ kiểu phụ đề khi đổi từ tab/side panel khác.
        if (cfg.subStyle && JSON.stringify(cfg.subStyle) !== JSON.stringify(subStyle)) {
          subStyle = Object.assign({}, SUBSTYLE_DEFAULT, cfg.subStyle); applySubStyle();
          if (optPanel.classList.contains('sd-open')) buildOptPanel();
        }
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
        '<span class="sd-toggle-state" title="Bật/Tắt extension trên video này">ON</span>' +
        '<span class="sd-toggle-gear" title="Tùy chọn phụ đề (font, cỡ chữ, màu, ngôn ngữ dịch)">⚙</span>';
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
      // Bánh răng ⚙: mở/đóng bảng tùy chọn phụ đề.
      const gearEl = btn.querySelector('.sd-toggle-gear');
      if (gearEl) gearEl.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        attach(); // đảm bảo optPanel đã nằm trong player
        toggleOptPanel();
      });
      controls.insertBefore(btn, controls.firstChild);
      updateToggleBtn();
    }
    placeToggleBtn();
    setInterval(placeToggleBtn, 2000);
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})(window);
