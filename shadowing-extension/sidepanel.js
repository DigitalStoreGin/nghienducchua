/* sidepanel.js — UI Side Panel; dieu khien content script qua Port-based messages.
 * Rebuild theo Trancy: Port connection thay vi fire-and-forget sendMessage.
 *
 * - connect() tao chrome.runtime.connect({ name: 'sidepanel' })
 * - Reactive UI update qua port.onMessage
 * - Reconnect on tab change
 * - Subtitle track selector */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const WORKER_URL = (typeof CONFIG !== 'undefined' ? CONFIG.WORKER_URL : null) || 'https://nghienducchua-proxy.thoatran21012.workers.dev';
  let settings = { rate: 1, repeat: 3, autoNext: true, autoRecord: true, segPause: true, engine: 'whisper', whisperModel: 'auto', useSileroVad: false, offsetMs: 0, nativeLang: 'vi', targetLang: 'de', uiLang: 'vi', videoSubs: true, hideText: false, serverUrl: 'http://localhost:8000' };
  let sentences = [], favorites = [], current = 0;
  let recState = ''; // trang thai engine hien tai (de phim Space biet nen ghi hay finalize)
  let port = null;
  let connected = false;
  let replyCallbacks = {};
  let replyCounter = 0;

  function micErrorMessage(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || /not-allowed|permission|denied/i.test(error && error.message)) return 'Chrome đang chặn micro. Mở quyền Microphone của extension rồi thử lại.';
    if (name === 'NotFoundError') return 'Không tìm thấy micro trên thiết bị.';
    if (name === 'NotReadableError') return 'Micro đang được ứng dụng khác sử dụng.';
    return 'Không mở được micro: ' + ((error && error.message) || error || 'lỗi không xác định');
  }

  // Mở trang xin quyền micro của extension (cùng origin với Side Panel).
  // Hộp thoại micro hiện đúng trong TAB (có thanh địa chỉ) — Side Panel thì không.
  function openMicPermissionPage() {
    try {
      const url = chrome.runtime.getURL('mic-permission.html');
      if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
      else window.open(url, '_blank');
    } catch (_) {}
  }

  function isMicBlocked(error) {
    return (error && error.name === 'NotAllowedError') || /not-allowed|permission|denied/i.test((error && error.message) || '');
  }

  async function enableMic(options) {
    const button = $('#micButton');
    const silent = options && options.silent;
    const markReady = () => { if (button) { button.classList.remove('pending'); button.classList.add('ready'); button.dataset.ready = '1'; } };
    try {
      if (button) { button.disabled = true; button.classList.add('pending'); }
      // 1) ƯU TIÊN: cấp quyền NGAY trên trang YouTube/Netflix (hộp thoại hiện tại trang, KHÔNG mở tab).
      const onPage = await cmd('ensureMic');
      if (onPage && onPage.ok && onPage.state !== 'denied') {
        markReady();
        if (!silent) setStatus('🎤 Micro đã bật ngay trên trang — chọn một câu và nói.', 'ok');
        return true;
      }
      // Đang ở trang có content script:
      if (onPage && onPage.onPage) {
        if (button) button.classList.remove('pending');
        // Bị chặn cứng -> hướng dẫn sửa NGAY trên trang (không mở tab).
        if (!silent) setStatus('🎤 Bấm biểu tượng 🔒/🎤 cạnh thanh địa chỉ của tab → Microphone → Allow → bấm Bật mic lại.', 'warn');
        return false;
      }
      // onPage == null (hộp thoại có thể đang chờ trên trang) & đang ở YouTube/Netflix -> chờ user bấm Allow.
      const tab = await activeTab();
      if (tab && /youtube\.com|netflix\.com/.test(tab.url || '')) {
        if (button) button.classList.remove('pending');
        if (!silent) setStatus('🎤 Hãy bấm "Allow / Cho phép" ở hộp thoại micro trên trang, rồi bấm Bật mic lần nữa.', 'warn');
        return false;
      }
      // 2) DỰ PHÒNG: không ở trang hỗ trợ -> mic của Side Panel.
      await window.ShadowMic.ensureMic();
      markReady();
      if (!silent) setStatus('Micro đã sẵn sàng — hãy chọn một câu và bắt đầu nói.', 'ok');
      return true;
    } catch (error) {
      if (button) button.classList.remove('pending', 'ready');
      // Bị chặn quyền cứng ở cả hai nơi -> mở trang cấp quyền của extension (phương án cuối).
      if (isMicBlocked(error)) {
        if (!silent) {
          openMicPermissionPage();
          setStatus('🎤 Trên trang YouTube: bấm 🔒/🎤 cạnh thanh địa chỉ → Microphone → Allow. Nếu vẫn chặn, dùng tab vừa mở.', 'warn');
          renderFeedback({ error: 'mic:blocked' });
        }
      } else if (!silent) {
        setStatus(micErrorMessage(error), 'warn');
        renderFeedback({ error: 'mic:' + ((error && error.message) || error) });
      }
      return false;
    } finally { if (button) button.disabled = false; }
  }

  // Báo cho trình ghi âm TRÊN TRANG (page-mic.js) dừng/kết thúc — vì ghi âm có thể
  // đang chạy ngay trên tab YouTube chứ không phải ở Side Panel.
  function pageMicSignal(action) {
    try { activeTab().then((t) => { if (t) chrome.tabs.sendMessage(t.id, { sd: 'page-mic', action }).catch(() => {}); }); } catch (e) {}
  }

  async function startShadow(i) {
    // Huy lan ghi am cu (neu dang treo) de bat dau moi -> luon co phan hoi
    try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (e) {}
    pageMicSignal('abort');
    if (settings.autoRecord && !await enableMic({ silent: true })) return;
    $('#fb').hidden = true;
    setStatus('▶️ Bắt đầu luyện câu…');
    await cmd('shadow', { i });
  }

  // --- Port-based communication ---
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'sidepanel' });
      connected = true;
      updateConnIndicator(true);

      port.onMessage.addListener((msg) => {
        if (!msg) return;
        // Reply callback
        if (msg.sd === 'evt' && msg.evt === '_reply' && msg.payload && msg.payload._replyId) {
          const cb = replyCallbacks[msg.payload._replyId];
          if (cb) { delete replyCallbacks[msg.payload._replyId]; cb(msg.payload.data); }
          return;
        }
        // Tab changed
        if (msg._tabChanged || msg._tabUpdated) {
          refresh();
          return;
        }
        // Events from content script
        if (msg.sd === 'evt') handleEvent(msg);
      });

      port.onDisconnect.addListener(() => {
        port = null;
        connected = false;
        updateConnIndicator(false);
        // Auto-reconnect
        setTimeout(connectPort, 1500);
      });
    } catch (e) {
      connected = false;
      updateConnIndicator(false);
      setTimeout(connectPort, 2000);
    }
  }

  function updateConnIndicator(on) {
    const el = $('#conn');
    if (el) el.classList.toggle('on', on);
  }

  // Send command to content script via port
  function cmd(name, args) {
    return new Promise((resolve) => {
      const id = ++replyCounter;
      const timeout = setTimeout(() => { delete replyCallbacks[id]; resolve(null); }, 8000);
      replyCallbacks[id] = (data) => { clearTimeout(timeout); resolve(data); };
      const msg = { sd: 'cmd', cmd: name, args: args || {}, _replyId: id };
      // Try port
      try {
        if (port) { port.postMessage(msg); return; }
      } catch (e) { port = null; }
      // Fallback: sendMessage
      activeTab().then((t) => {
        if (!t) { clearTimeout(timeout); delete replyCallbacks[id]; resolve(null); return; }
        chrome.tabs.sendMessage(t.id, msg).then((r) => {
          clearTimeout(timeout); delete replyCallbacks[id]; resolve(r);
        }).catch(() => {
          clearTimeout(timeout); delete replyCallbacks[id]; showNoHost(true); resolve(null);
        });
      });
    });
  }

  async function activeTab() { const t = await chrome.tabs.query({ active: true, currentWindow: true }); return t[0]; }
  function showNoHost(b) { $('#nohost').hidden = !b; }

  // --- Handle events from content script ---
  function handleEvent(msg) {
    if (!msg || msg.sd !== 'evt') return;
    const p = msg.payload;
    switch (msg.evt) {
      case 'sentences': sentences = p || []; renderList(); break;
      case 'current': current = p.idx; renderNow(p); markCur(p.idx); break;
      case 'playstate': { const b = $('#btn-play-pause') || $('.cbtn.play'); if (b) { const ic = b.querySelector('.tb-ico') || b; ic.textContent = p.playing ? '⏸' : '▶'; const lb = b.querySelector('.tb-label'); if (lb) lb.textContent = p.playing ? 'Dừng' : 'Phát'; } break; }
      case 'loop': $('#loop').classList.toggle('on', p); break;
      case 'state': onState(p); break;
      case 'feedback': renderFeedback(p); break;
      case 'progress': onProgress(p); break;
      case 'status': setStatus(p.text, p.kind); break;
      case 'done': {
        // Queue complete — show session stats modal if has data, else generic modal
        if (streakData.sessionSentences > 0) {
          showSessionStats();
        } else {
          const m = $('#modal-backdrop'); if (m) m.hidden = false;
        }
        break;
      }
    }
  }

  // Also listen via chrome.runtime.onMessage for events not going through port
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.sd === 'evt') handleEvent(msg);
  });

  function setStatus(t, kind) { const s = $('#status'); s.textContent = t; s.className = 'status' + (kind ? ' ' + kind : ''); }
  function onState(st) {
    const map = {
      playing: '▶️ Playing…',
      paused: '⏸ Paused',
      recording: '🎤 Listening… (speak then it will score)',
      scoring: '🧮 Scoring…',
      ad: '📺 Waiting for ad to end…',
    };
    recState = st.state || '';
    const fb = $('#finalizeBtn'); if (fb) fb.hidden = st.state !== 'recording';
    if (st.state && map[st.state]) setStatus(map[st.state] + (st.rep != null ? ' (rep ' + (st.rep + 1) + ')' : ''));
    // Show record panel when recording starts
    if (st.state === 'recording') {
      const el = $('#you-said-text'); if (el) el.textContent = 'Listening…';
      showRecordPanel(true);
      startWaveform();
    } else {
      stopWaveform();
    }
  }
  function onProgress(p) {
    const el = $('#prog'); el.hidden = false;
    el.querySelector('span').textContent = (p.status || '') + (p.pct != null ? ' ' + p.pct + '%' : '');
    el.querySelector('i').style.width = (p.pct || 0) + '%';
    if (p.status === 'done' || p.pct === 100) setTimeout(() => { el.hidden = true; }, 1200);
  }

  function renderNow(c) {
    const s = c.sentence || sentences[c.idx]; if (!s) return;
    $('#nowDe').textContent = s.text;
    $('#nowTr').textContent = s.trans || '';
    $('#count').textContent = (c.idx + 1) + '/' + (c.total || sentences.length);
    wireWordLookup($('#nowDe'), s.text);
    // Update practice view elements
    const curEl = $('#current-text'); if (curEl) { curEl.textContent = s.text; wireWordLookup(curEl, s.text); }
    const nextEl = $('#next-text'); const nextS = sentences[c.idx + 1]; if (nextEl) nextEl.textContent = nextS ? nextS.text : '';
    const trEl = $('#trans-text'); if (trEl) trEl.textContent = s.trans || '';
    updateSourceInfo(c.idx);
    if (typeof current === 'number') { current = c.idx; }
    updateTryCard();
    // Phụ đề kép: nếu chưa có bản dịch & đã đăng nhập -> tự dịch câu hiện tại
    if (!s.trans && (typeof ShadowAuth !== 'undefined' ? ShadowAuth.isLoggedIn() : false)) {
      translateText(s.text, settings.targetLang || 'de', settings.nativeLang || 'vi').then((t) => {
        if (t) { s.trans = t; if ($('#nowDe').textContent === s.text) { $('#nowTr').textContent = t; if (trEl) trEl.textContent = t; } }
      });
    }
  }
  function markCur(i) { document.querySelectorAll('.row').forEach((r) => r.classList.toggle('cur', +r.dataset.i === i)); const r = document.querySelector('.row[data-i="' + i + '"]'); if (r) r.scrollIntoView({ block: 'nearest' }); }

  function isFav(t) { return favorites.some((f) => f.text === t); }

  // Chon mot cau trong danh sach (kieu ShadowEcho): KHONG nhay sang man luyen ngay.
  // Chi danh dau cau + phat doan video cua cau do, va cap nhat the "Luyen cau nay" o tren.
  // Nguoi dung bam "Nói & chấm" tren the (hoac nut mic duoi) moi bat dau ghi am.
  function selectRow(i) {
    if (i < 0 || i >= sentences.length) return;
    current = i;
    cmd('select', { i });            // tua + phat doan video cua cau nay (tu dung cuoi cau neu bat)
    markCur(i);                      // chi doi vien dong dang chon — khong ve lai ca danh sach
    updateTryCard();
    const s = sentences[i];
    if (s) renderNow({ idx: i, total: sentences.length, sentence: s });
  }

  // The luyen tap o dau danh sach (kieu "Try your first shadow" cua ShadowEcho):
  // hien cau dang chon + nut Nghe / Nói & chấm.
  function updateTryCard() {
    const card = $('#try-shadow-card'); if (!card) return;
    const has = sentences.length > 0;
    card.hidden = !has;
    if (!has) return;
    const s = sentences[current] || sentences[0];
    const txt = $('#try-card-text'); if (txt) txt.textContent = s ? '“' + s.text + '”' : '—';
  }

  function renderList() {
    const c = $('#list'); c.innerHTML = '';
    const filtered = filterSentences();
    // Show/hide filter bar + the luyen tap
    const filterBar = $('#status-filter'); if (filterBar) filterBar.hidden = !sentences.length;
    updateTryCard();
    if (!sentences.length) { c.innerHTML = '<div class="empty">Chưa có phụ đề. Bấm "Lấy phụ đề" ở trên.</div>'; return; }
    if (!filtered.length) { c.innerHTML = '<div class="empty">Không có câu nào khớp bộ lọc.</div>'; return; }
    filtered.forEach((s) => {
      const i = sentences.indexOf(s);
      const row = document.createElement('div'); row.className = 'row' + (i === current ? ' cur' : ''); row.dataset.i = i;
      // Tam giac phat (▷) — chon + phat cau nay
      const playBtn = document.createElement('button'); playBtn.className = 'row-play-btn'; playBtn.textContent = '▷';
      playBtn.title = 'Nghe & chọn câu này';
      playBtn.onclick = (e) => { e.stopPropagation(); selectRow(i); };
      row.appendChild(playBtn);
      // Than chu — chu to, de doc (kieu hinh mau)
      const body = document.createElement('div'); body.className = 'row-body';
      const de = document.createElement('div'); de.className = 'de'; de.textContent = s.text;
      body.appendChild(de);
      if (s.trans) { const tr = document.createElement('div'); tr.className = 'tr'; tr.textContent = s.trans; body.appendChild(tr); }
      row.appendChild(body);
      // Cham trang thai (nho, goc phai)
      const dot = document.createElement('span');
      dot.className = 'row-status-dot ' + getSentStatus(s.text);
      row.appendChild(dot);
      // Bam vao dong = chon cau (KHONG nhay sang man luyen ngay).
      row.onclick = () => selectRow(i);
      c.appendChild(row);
    });
  }
  function mk(cls, txt, on) { const b = document.createElement('button'); b.className = cls; b.textContent = txt; b.onclick = on; return b; }

  function renderFeedback(f) {
    const box = $('#fb'); box.hidden = false;
    if (f.error) {
      let m = f.error, micFix = false;
      if (/server-unavailable/.test(f.error)) m = 'Cannot reach STT Server (' + f.error.replace('server-unavailable:', '') + '). Check server URL or switch Engine to Web Speech.';
      else if (/whisper-unavailable/.test(f.error)) m = 'Whisper not ready — run build-release to embed it, or switch Engine to Web Speech.';
      else if (/^mic|not-allowed/.test(f.error)) { m = 'Side Panel cần quyền micro của <b>extension</b> (khác với quyền của youtube.com). Bấm nút bên dưới để cấp quyền.'; micFix = true; }
      else if (/empty-transcript/.test(f.error)) { m = '🤔 Nothing heard. Try speaking louder or check your mic.'; }
      box.innerHTML = '<div class="err">⚠️ ' + m + (micFix ? ' <button class="mini sh" id="micfix">🎤 Cấp quyền micro</button>' : '') + '</div>';
      if (micFix) $('#micfix').onclick = () => openMicPermissionPage();
      return;
    }
    const sc = f.score;
    // Track XP and sentence status
    if (sc.overall != null) {
      recordPractice(sc.overall);
      const curSent = sentences[current];
      if (curSent) autoUpdateStatus(curSent.text, sc.overall);
    }
    // Animated score rings (like ELSA Speak)
    const ring = (label, val) => {
      const v = val == null || val === '—' ? null : +val;
      const cls = v == null ? '' : (v >= 80 ? 'hi' : v >= 55 ? 'mid' : 'lo');
      const pct = v == null ? 0 : v;
      const r = 24, circ = 2 * Math.PI * r;
      const offset = circ - (pct / 100) * circ;
      return `<div class="score-ring">
        <div class="score-ring-svg-wrap">
          <svg width="58" height="58" viewBox="0 0 58 58">
            <circle class="score-ring-track" cx="29" cy="29" r="${r}"/>
            <circle class="score-ring-fill ${cls}" cx="29" cy="29" r="${r}"
              stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
          </svg>
          <div class="score-ring-val">${v == null ? '—' : v}</div>
        </div>
        <div class="score-ring-lbl">${label}</div>
      </div>`;
    };
    const words = sc.words.map((w) => '<span class="fw ' + w.status + '" title="heard: ' + esc(w.heard || '—') + '">' + esc(w.text) + '</span>').join(' ');
    box.innerHTML = '<div class="score-ring-wrap" style="position:relative">' +
      ring('Overall', sc.overall) + ring('Pronunc.', sc.pronunciation) +
      ring('Fluency', sc.fluency) + ring('Intonation', sc.intonation) + '</div>' +
      '<div class="words">' + words + '</div>' +
      '<div class="heard">You said: <i>' + esc(sc.transcript || '(nothing heard)') + '</i> · ' + esc(sc.engine || '') + '</div>' +
      (sc.lowConfidence ? '<div class="err" style="margin-top:6px">🤔 Nhận diện chưa chắc chắn — thử nói lại rõ hơn để chấm chính xác.</div>' : '');
    // Update record panel
    const ys = $('#you-said-text'); if (ys) ys.textContent = sc.transcript || '–';
    const mp = $('#match-pct'); if (mp) mp.textContent = sc.overall != null ? 'Match ' + sc.overall + '%' : 'Match –';
    showRecordPanel(true);
    // Update score gauges in practice view
    const so = $('#score-overall'); if (so) so.textContent = sc.overall ?? '–';
    const sp = $('#score-pron'); if (sp) sp.textContent = sc.pronunciation ?? '–';
    const sf = $('#score-flu'); if (sf) sf.textContent = sc.fluency ?? '–';
    const si = $('#score-into'); if (si) si.textContent = sc.intonation ?? '–';
    const wr = $('#word-row'); if (wr) wr.innerHTML = words;
    const fbx = $('#feedback-box'); if (fbx) fbx.hidden = false;
  }

  function wireWordLookup(container, text) {
    container.innerHTML = '';
    // To mau theo tan suat (kieu Language Reactor): chi cho tieng Duc
    const freqOn = (settings.targetLang || 'de') === 'de' && window.SD_FREQ_DE;
    text.split(/(\s+)/).forEach((w) => {
      if (/^\s*$/.test(w)) { container.appendChild(document.createTextNode(w)); return; }
      const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = w;
      if (freqOn && window.SD_FREQ_DE && !window.SD_FREQ_DE.isCommon(w)) sp.classList.add('freq-rare');
      sp.onclick = (e) => { e.stopPropagation(); lookup(w, text, e.clientX, e.clientY); };
      container.appendChild(sp);
    });
  }
  function lookup(word, ctx, x, y) {
    document.querySelectorAll('.pop').forEach((p) => p.remove());
    const clean = word.replace(/[^A-Za-zäöüÄÖÜß]/g, '');
    const pop = document.createElement('div'); pop.className = 'pop'; pop.style.left = Math.min(x, innerWidth - 160) + 'px'; pop.style.top = (y + 8) + 'px';
    pop.innerHTML = '<b>' + clean + '</b><a target="_blank" href="https://www.dwds.de/wb/' + encodeURIComponent(clean) + '">DWDS</a><a target="_blank" href="https://dict.leo.org/german-english/' + encodeURIComponent(clean) + '">LEO</a><button class="l">🔊 Nghe</button><button class="s">⭐ Lưu</button>';
    pop.querySelector('.l').onclick = () => speakText(clean);
    pop.querySelector('.s').onclick = () => { cmd('saveWord', { word: clean, context: ctx }); pop.remove(); };
    const gloss = document.createElement('div'); gloss.style.cssText = 'font-size:12px;color:#86efac'; gloss.textContent = '… đang tra nghĩa';
    pop.insertBefore(gloss, pop.children[1]);
    fetchGloss(clean).then((g) => { gloss.textContent = g || '(không có nghĩa)'; });
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener('click', function h() { pop.remove(); document.removeEventListener('click', h); }), 50);
  }

  // ---- Tabs ----
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
    ['practice', 'vocab', 'progress', 'flash'].forEach((t) => $('#' + t).hidden = t !== b.dataset.tab);
    if (b.dataset.tab === 'vocab' || b.dataset.tab === 'progress') loadVocab(b.dataset.tab);
    if (b.dataset.tab === 'flash') loadFlashCards();
  });
  async function loadVocab(tab) {
    const r = await cmd('vocab'); if (!r) return;
    if (tab === 'vocab') {
      const has = r.savedWords && r.savedWords.length;
      const n = (r.savedWords && r.savedWords.length) || 0;
      const bar = '<div class="vocbar">' +
        '<button class="btn" id="ankiBtn"' + (has ? '' : ' disabled') + '>⬇️ Xuất Anki .txt (' + n + ')</button>' +
        '<button class="btn" id="ankiConnectBtn"' + (has ? '' : ' disabled') + ' title="Cần Anki đang mở + addon AnkiConnect">→ Anki (live)</button>' +
        '</div>';
      const body = has ? r.savedWords.map((w) => '<div class="voc"><b>' + esc(w.word) + '</b><i>' + esc(w.context || '') + '</i></div>').join('') : '<div class="empty">Chưa lưu từ nào.</div>';
      $('#vocab').innerHTML = bar + body;
      const ab = $('#ankiBtn'); if (ab && has) ab.onclick = exportAnki;
      const ac = $('#ankiConnectBtn'); if (ac && has) ac.onclick = exportAnkiConnect;
    } else {
      const h = r.history || []; if (!h.length) { $('#progress').innerHTML = '<div class="empty">Chưa có lượt luyện.</div>'; return; }
      const avg = (k) => Math.round(h.reduce((a, x) => a + (x[k] || 0), 0) / h.length);
      $('#progress').innerHTML = '<div class="stat">Tổng lượt <b>' + h.length + '</b> · TB phát âm <b>' + avg('pronunciation') + '</b> · trôi chảy <b>' + avg('fluency') + '</b> · tổng <b>' + avg('overall') + '</b></div>' +
        h.slice(0, 40).map((x) => '<div class="hrow"><span>' + (x.overall || 0) + '</span><i>' + (x.text || '').slice(0, 70) + '</i></div>').join('');
    }
  }

  // ---- Controls / commands ----
  document.querySelectorAll('[data-cmd]').forEach((b) => {
    const c = b.dataset.cmd;
    if (['loadAuto', 'prev', 'next', 'togglePlay', 'stop'].includes(c)) b.onclick = () => {
      if (c === 'stop') { try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (e) {} pageMicSignal('abort'); const fb = $('#finalizeBtn'); if (fb) fb.hidden = true; }
      cmd(c, { target: settings.targetLang, native: settings.nativeLang });
    };
    if (c === 'mic') b.onclick = () => enableMic();
    if (c === 'shadowFav') b.onclick = async () => { if (!settings.autoRecord || await enableMic({ silent: true })) cmd(c, { target: settings.targetLang, native: settings.nativeLang }); };
    if (c === 'live') b.onclick = async () => { const r = await cmd('live'); if (r) b.classList.toggle('on', !!r.running); };
    if (c === 'loop') b.onclick = async () => { const r = await cmd('loop'); if (r) b.classList.toggle('on', !!r.loop); };
    if (c === 'shadowCur') b.onclick = () => startShadow(current);
    if (c === 'speakCur') b.onclick = () => { const s = sentences[current]; if (s) speakText(s.text); };
    if (c === 'dictate') b.onclick = () => startDictation();
    if (c === 'diag') b.onclick = () => runDiag();
    if (c === 'cloze') b.onclick = () => startCloze();
  });
  $('#file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const text = await f.text(); cmd('loadText', { text }); };

  // ---- Settings ----
  function bindSetting(id, key, type) {
    const el = $('#' + id);
    el.onchange = () => { settings[key] = type === 'bool' ? el.checked : (type === 'num' ? +el.value : el.value); cmd('settings', settings); };
  }
  bindSetting('rate', 'rate', 'num'); bindSetting('rep', 'repeat', 'num'); bindSetting('autonext', 'autoNext', 'bool');
  bindSetting('autorec', 'autoRecord', 'bool'); bindSetting('segpause', 'segPause', 'bool'); bindSetting('engine', 'engine', 'str'); bindSetting('offset', 'offsetMs', 'num');
  bindSetting('silerovad', 'useSileroVad', 'bool');
  if ($('#whisperModel')) $('#whisperModel').onchange = () => {
    settings.whisperModel = $('#whisperModel').value; cmd('settings', settings);
    updateHwInfo();
    // Nạp sẵn model mới chọn để lần ghi âm sau không phải chờ
    try { if (settings.engine === 'whisper' && window.ShadowMic) window.ShadowMic.warmupWhisper(settings.whisperModel); } catch (_) {}
  };
  bindSetting('target', 'targetLang', 'str'); bindSetting('native', 'nativeLang', 'str'); bindSetting('serverurl', 'serverUrl', 'str');
  $('#vsubs').onchange = (e) => { settings.videoSubs = e.target.checked; cmd('settings', settings); cmd('vsubs', { on: e.target.checked }); };
  $('#uilang').onchange = (e) => { settings.uiLang = e.target.value; cmd('settings', settings); applyI18n(settings.uiLang); };
  function applySettings() {
    $('#rate').value = settings.rate; $('#rep').value = settings.repeat; $('#autonext').checked = settings.autoNext;
    $('#autorec').checked = settings.autoRecord; $('#engine').value = settings.engine; $('#offset').value = settings.offsetMs;
    if ($('#whisperModel')) $('#whisperModel').value = settings.whisperModel || 'auto';
    if ($('#silerovad')) $('#silerovad').checked = !!settings.useSileroVad;
    if ($('#segpause')) $('#segpause').checked = settings.segPause !== false;
    updateHwInfo();
    $('#target').value = settings.targetLang || 'de'; $('#native').value = settings.nativeLang || 'vi';
    $('#uilang').value = settings.uiLang || 'vi'; $('#vsubs').checked = settings.videoSubs !== false;
    if ($('#serverurl')) $('#serverurl').value = settings.serverUrl || 'http://localhost:8000';
    applyBlur(!!settings.hideText);
    applyI18n(settings.uiLang || 'vi');
  }

  // ===== Che do an/mo chu (tu kiem tra) =====
  function applyBlur(on) {
    document.body.classList.toggle('hide-text', !!on);
    const b = $('#blurBtn'); if (b) b.classList.toggle('on', !!on);
  }
  function toggleBlur() {
    settings.hideText = !settings.hideText;
    applyBlur(settings.hideText);
    cmd('settings', settings);
  }

  // Doi toc do phat trong khoang cho phep (0.5 / 0.75 / 1)
  function changeRate(delta) {
    const steps = [0.5, 0.75, 1];
    let i = steps.indexOf(+settings.rate); if (i < 0) i = steps.length - 1;
    i = Math.max(0, Math.min(steps.length - 1, i + delta));
    settings.rate = steps[i];
    const sel = $('#rate'); if (sel) sel.value = settings.rate;
    cmd('settings', settings);
    setStatus('Tốc độ: ' + settings.rate + 'x');
  }

  // ---- Init / refresh ----
  async function refresh() {
    // Update tab tracking
    const t = await activeTab();
    if (t && port) {
      try { port.postMessage({ _setTab: t.id }); } catch (e) {}
    }
    const r = await cmd('getState');
    if (!r || !r.ok) { showNoHost(true); return; }
    showNoHost(false);
    settings = Object.assign(settings, r.settings || {}); favorites = r.favorites || []; sentences = r.sentences || []; current = r.current || 0;
    applySettings(); renderList(); if (sentences[current]) renderNow({ idx: current, total: sentences.length, sentence: sentences[current] });
  }

  // Listen for tab changes
  chrome.tabs.onActivated.addListener(refresh);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') refresh(); });

  // ===== Xuất Anki (.txt tab-separated — Anki import trực tiếp) =====
  // Famous-extension feature (Language Reactor / Migaku / asbplayer): xuất flashcard.
  async function exportAnki() {
    const r = await cmd('vocab'); const words = (r && r.savedWords) || [];
    if (!words.length) { setStatus('Chưa có từ để xuất.', 'warn'); return; }
    const btn = $('#ankiBtn'); if (btn) btn.disabled = true;
    setStatus('Đang tạo file Anki… (đang tra nghĩa)');
    const clean = (t) => String(t == null ? '' : t).replace(/[\t\r\n]+/g, ' ').trim();
    const rows = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      let gloss = '';
      try { gloss = await fetchGloss(w.word); } catch (e) {}
      rows.push([clean(w.word), clean(gloss), clean(w.context)].join('\t'));
      if (btn) btn.textContent = '⏳ ' + (i + 1) + '/' + words.length;
    }
    // Anki directives: cot1=Front (từ), cot2=Back (nghĩa), cot3=ngữ cảnh
    const tsv = '#separator:tab\n#html:false\n#columns:Front\tBack\tContext\n' + rows.join('\n');
    try {
      const blob = new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'shadow-anki.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus('✅ Đã xuất ' + words.length + ' thẻ → mở Anki → File → Import.', 'ok');
    } catch (e) { setStatus('Không tạo được file: ' + (e.message || e), 'warn'); }
    if (btn) { btn.disabled = false; btn.textContent = '⬇️ Xuất Anki (' + words.length + ')'; }
  }

  // ===== Đồng bộ thẳng sang Anki qua AnkiConnect (localhost:8765) =====
  async function ankiInvoke(action, params) {
    const res = await fetch('http://localhost:8765', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params: params || {} }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.result;
  }
  async function exportAnkiConnect() {
    const r = await cmd('vocab'); const words = (r && r.savedWords) || [];
    if (!words.length) { setStatus('Chưa có từ để gửi.', 'warn'); return; }
    const btn = $('#ankiConnectBtn'); if (btn) btn.disabled = true;
    const deck = 'Shadow Deutsch';
    try {
      await ankiInvoke('createDeck', { deck });
      setStatus('Đang tra nghĩa & gửi sang Anki…');
      const notes = [];
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        let gloss = ''; try { gloss = await fetchGloss(w.word); } catch (e) {}
        notes.push({
          deckName: deck, modelName: 'Basic',
          fields: { Front: w.word, Back: (gloss || '') + (w.context ? ('<br><br><i>' + w.context + '</i>') : '') },
          options: { allowDuplicate: false }, tags: ['shadow-deutsch'],
        });
        if (btn) btn.textContent = '⏳ ' + (i + 1) + '/' + words.length;
      }
      const result = await ankiInvoke('addNotes', { notes });
      const added = (result || []).filter((x) => x != null).length;
      setStatus('✅ Đã gửi ' + added + '/' + words.length + ' thẻ vào deck "' + deck + '".', 'ok');
    } catch (e) {
      const msg = /Failed to fetch|NetworkError/i.test(e.message || '')
        ? 'Không kết nối được Anki. Mở Anki + cài addon AnkiConnect (code 2055492159) rồi thử lại.'
        : 'Lỗi AnkiConnect: ' + (e.message || e);
      setStatus(msg, 'warn');
    }
    if (btn) { btn.disabled = false; btn.textContent = '→ Anki (live)'; }
  }

  // ===== Dịch thuật qua Cloudflare Worker (API keys lưu phía server, mã hóa an toàn) =====
  // Khách hàng chỉ cần nhập License Key — không thấy DeepL/OpenRouter keys.
  const transCache = {};
  const OR_MODELS = [
    'openai/gpt-oss-120b:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
  ];
  const DEEPL_TGT = { vi: 'VI', en: 'EN-US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', ja: 'JA', zh: 'ZH', ko: 'KO' };
  const LANG_NAME = { vi: 'Vietnamese', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', ja: 'Japanese', zh: 'Chinese', ko: 'Korean' };

  function workerHeaders() {
    return (typeof ShadowAuth !== 'undefined') ? ShadowAuth.workerHeaders() : { 'Content-Type': 'application/json' };
  }

  // Khi đã hết quota trong phiên -> ngừng gọi lại (tránh spam 429 + bật modal liên tục).
  let _quotaHitDeepL = false, _quotaHitAI = false;

  async function deeplTranslate(text, from, to) {
    if (typeof ShadowAuth === 'undefined' || !ShadowAuth.isLoggedIn() || _quotaHitDeepL) return '';
    const tgt = DEEPL_TGT[to]; if (!tgt) return '';
    const body = { text, target_lang: tgt };
    if (DEEPL_TGT[from]) body.source_lang = DEEPL_TGT[from].split('-')[0];
    const r = await fetch(WORKER_URL + '/translate', { method: 'POST', headers: workerHeaders(), body: JSON.stringify(body) });
    if (!r.ok) {
      if (r.status === 429) { _quotaHitDeepL = true; try { await r.json(); } catch (_) {} showUpgradeModal('Đã hết hạn mức dịch hôm nay. Nâng cấp để tiếp tục.'); return ''; }
      throw new Error('worker-deepl-' + r.status);
    }
    const j = await r.json();
    return (j.translations && j.translations[0] && j.translations[0].text) || '';
  }

  async function openrouterTranslate(text, from, to, model) {
    if (typeof ShadowAuth === 'undefined' || !ShadowAuth.isLoggedIn() || _quotaHitAI) return '';
    const r = await fetch(WORKER_URL + '/ai-translate', {
      method: 'POST',
      headers: workerHeaders(),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 500,
        messages: [
          { role: 'system', content: 'You are a professional translator. Output ONLY the translation — no quotes, no notes, no explanations.' },
          { role: 'user', content: 'Translate from ' + (LANG_NAME[from] || from) + ' to ' + (LANG_NAME[to] || to) + ':\n\n' + text },
        ],
      }),
    });
    if (!r.ok) {
      if (r.status === 429) { _quotaHitAI = true; showUpgradeModal('Đã hết hạn mức AI hôm nay. Nâng cấp để tiếp tục.'); return ''; }
      throw new Error('worker-or-' + r.status);
    }
    const j = await r.json();
    return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  }

  async function myMemoryTranslate(text, from, to) {
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + from + '|' + to);
    const j = await r.json();
    return (j && j.responseData && j.responseData.translatedText) || '';
  }

  // --- API dịch MIỄN PHÍ (không cần key), kiểu GTranslate (d4n3436/GTranslate) ---
  // Chỉ dùng làm DỰ PHÒNG khi OpenRouter/DeepL lỗi hoặc trả kết quả sai.
  async function googleFreeTranslate(text, from, to) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
      encodeURIComponent(from || 'auto') + '&tl=' + encodeURIComponent(to) + '&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(url);
    if (!r.ok) throw new Error('google-' + r.status);
    const j = await r.json();
    // j[0] = [[chunkDịch, chunkGốc, ...], ...] — chỉ map khi đúng dạng mảng (tránh throw khi bị chặn/HTML)
    if (!j || !Array.isArray(j[0])) return '';
    return j[0].map((seg) => (seg && seg[0]) || '').join('').trim();
  }
  let _msTok = null, _msTokAt = 0;
  async function msAuthToken(force) {
    if (force || !_msTok || Date.now() - _msTokAt > 9 * 60 * 1000) {
      const tr = await fetch('https://edge.microsoft.com/translate/auth');
      if (!tr.ok) throw new Error('ms-auth-' + tr.status);
      const tok = (await tr.text()).trim();
      if (!tok) throw new Error('ms-auth-empty');
      _msTok = tok; _msTokAt = Date.now();
    }
    return _msTok;
  }
  async function microsoftFreeTranslate(text, from, to) {
    const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=' +
      encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to);
    const doFetch = async (tok) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: JSON.stringify([{ Text: text }]),
    });
    let r = await doFetch(await msAuthToken(false));
    if (r.status === 401) { _msTok = null; r = await doFetch(await msAuthToken(true)); } // token hết hạn -> lấy mới & thử lại 1 lần
    if (!r.ok) throw new Error('ms-' + r.status);
    const j = await r.json();
    return ((j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text) || '').trim();
  }

  function validTrans(out, src, from, to) {
    return (typeof ShadowValidate !== 'undefined')
      ? ShadowValidate.isValidTranslation(out, src, from, to)
      : !!(out && String(out).trim());
  }

  async function translateText(text, from, to) {
    if (!text) return '';
    const ck = from + '|' + to + '|' + text;
    if (transCache[ck]) return transCache[ck];
    // LUÔN ưu tiên OpenRouter (AI) -> DeepL. Mỗi nguồn đều KIỂM TRA kết quả trước khi nhận;
    // nếu rỗng/sai thì hạ xuống API miễn phí: Google -> Microsoft -> MyMemory (kiểu GTranslate).
    for (const m of OR_MODELS) {
      try { const t = await openrouterTranslate(text, from, to, m); if (validTrans(t, text, from, to)) { transCache[ck] = t; return t; } } catch (e) {}
    }
    try { const d = await deeplTranslate(text, from, to); if (validTrans(d, text, from, to)) { transCache[ck] = d; return d; } } catch (e) {}
    try { const g = await googleFreeTranslate(text, from, to); if (validTrans(g, text, from, to)) { transCache[ck] = g; return g; } } catch (e) {}
    try { const ms = await microsoftFreeTranslate(text, from, to); if (validTrans(ms, text, from, to)) { transCache[ck] = ms; return ms; } } catch (e) {}
    try { const t = await myMemoryTranslate(text, from, to); if (validTrans(t, text, from, to)) { transCache[ck] = t; return t; } } catch (e) {}
    // Tất cả nguồn dịch đều thất bại — báo về Worker /log để theo dõi
    try { if (self.ShadowReport) self.ShadowReport.error('all-translate-failed', { from, to, len: text.length }, 'translateText'); } catch (_) {}
    return '';
  }

  // Fetch /me profile from Worker (usage stats)
  async function fetchMe() {
    if (typeof ShadowAuth === 'undefined' || !ShadowAuth.isLoggedIn()) return null;
    try {
      const r = await fetch(WORKER_URL + '/me', { headers: workerHeaders() });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  const glossCache = {};
  async function fetchGloss(word) {
    if (glossCache[word]) return glossCache[word];
    const g = await translateText(word, 'de', settings.nativeLang || 'vi');
    glossCache[word] = g; return g;
  }

  // ===== 🔥 STREAK & XP SYSTEM (Duolingo-style) =====
  const STREAK_KEY = 'se_streak_v1';
  let streakData = { streak: 0, lastDate: null, xp: 0, sessionXp: 0, sessionScores: [], sessionSentences: 0 };

  async function loadStreak() {
    const r = await chrome.storage.local.get(STREAK_KEY);
    if (r[STREAK_KEY]) streakData = Object.assign(streakData, r[STREAK_KEY]);
    renderStreak();
  }

  async function saveStreak() {
    await chrome.storage.local.set({ [STREAK_KEY]: streakData });
  }

  function todayStr() { return new Date().toISOString().split('T')[0]; }

  async function recordPractice(score) {
    const today = todayStr();
    const xpEarned = score >= 80 ? 15 : score >= 60 ? 10 : 5;
    streakData.xp += xpEarned;
    streakData.sessionXp += xpEarned;
    streakData.sessionSentences++;
    streakData.sessionScores.push(score);

    // Update streak
    if (streakData.lastDate !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      streakData.streak = (streakData.lastDate === yesterday) ? streakData.streak + 1 : 1;
      streakData.lastDate = today;
    }
    await saveStreak();
    renderStreak();
  }

  function renderStreak() {
    const sc = $('#streak-count'); if (sc) sc.textContent = '🔥 ' + (streakData.streak || 0);
    const xc = $('#xp-count'); if (xc) xc.textContent = '⭐ ' + (streakData.xp || 0);
  }

  // ===== 🏷️ SENTENCE STATUS (LingQ-style: new/learning/known) =====
  const SENT_STATUS_KEY = 'se_sent_status_v1';
  let sentStatus = {};
  let statusFilter = 'all';

  async function loadSentStatus() {
    const r = await chrome.storage.local.get(SENT_STATUS_KEY);
    if (r[SENT_STATUS_KEY]) sentStatus = r[SENT_STATUS_KEY];
  }

  async function setSentStatus(text, status) {
    const key = text.slice(0, 60);
    const prev = sentStatus[key] || { practices: 0, bestScore: 0 };
    sentStatus[key] = Object.assign(prev, { status, updatedAt: Date.now() });
    await chrome.storage.local.set({ [SENT_STATUS_KEY]: sentStatus });
    renderList();
  }

  function getSentStatus(text) {
    return (sentStatus[text.slice(0, 60)] || {}).status || 'unseen';
  }

  function autoUpdateStatus(text, score) {
    const current = getSentStatus(text);
    const key = text.slice(0, 60);
    const prev = sentStatus[key] || { practices: 0, bestScore: 0 };
    prev.practices = (prev.practices || 0) + 1;
    prev.bestScore = Math.max(prev.bestScore || 0, score);
    prev.updatedAt = Date.now();
    if (score >= 80) prev.status = 'known';
    else if (score >= 50 || prev.practices >= 2) prev.status = 'learning';
    else if (current === 'unseen') prev.status = 'new';
    sentStatus[key] = prev;
    chrome.storage.local.set({ [SENT_STATUS_KEY]: sentStatus });
  }

  // ===== 🌙 DARK MODE =====
  async function loadDarkMode() {
    const r = await chrome.storage.local.get('se_dark_mode');
    if (r.se_dark_mode) applyDarkMode(true, false);
  }

  function applyDarkMode(on, save = true) {
    document.body.classList.toggle('dark', on);
    const btn = $('#btn-dark-mode'); if (btn) btn.textContent = on ? '☀️' : '🌙';
    if (save) chrome.storage.local.set({ se_dark_mode: on });
  }

  // ===== 🎯 ONBOARDING =====
  const ONBOARD_KEY = 'se_onboarding_v1';

  async function checkOnboarding() {
    const r = await chrome.storage.local.get(ONBOARD_KEY);
    return !!r[ONBOARD_KEY];
  }

  async function completeOnboarding(selectedLang) {
    if (selectedLang) {
      const targetEl = document.getElementById('target');
      if (targetEl) targetEl.value = selectedLang;
      settings.targetLang = selectedLang;
      cmd('settings', settings); // push to content script
    }
    await chrome.storage.local.set({ [ONBOARD_KEY]: true });
    showView('list');
    refresh(); // load subtitle list for the active tab
  }

  function initOnboardingUI() {
    let selectedLang = 'de';

    // Lang buttons
    document.querySelectorAll('.onboard-lang-btn').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.onboard-lang-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedLang = btn.dataset.lang;
      };
    });
    // Set default selected
    const defBtn = document.querySelector('.onboard-lang-btn[data-lang="de"]');
    if (defBtn) defBtn.classList.add('selected');

    // Step navigation
    const goStep = (from, to) => {
      const fp = document.getElementById('onboard-page-' + from);
      const tp = document.getElementById('onboard-page-' + to);
      if (fp) fp.hidden = true;
      if (tp) { tp.hidden = false; }
      // Update dots
      const dots = document.querySelectorAll('.onboard-step-dot');
      dots.forEach((d, i) => d.classList.toggle('onboard-step-dot--active', i === to - 1));
    };

    const n1 = document.getElementById('onboard-next-1'); if (n1) n1.onclick = () => goStep(1, 2);
    const n2 = document.getElementById('onboard-next-2'); if (n2) n2.onclick = () => goStep(2, 3);
    const skip = document.getElementById('onboard-skip'); if (skip) skip.onclick = () => completeOnboarding(selectedLang);
    const finish = document.getElementById('onboard-finish'); if (finish) finish.onclick = () => completeOnboarding(selectedLang);
  }

  // ===== 💳 UPGRADE MODAL =====
  function showUpgradeModal(reason) {
    const modal = document.getElementById('upgrade-modal');
    const reasonEl = document.getElementById('upgrade-reason');
    if (reasonEl && reason) reasonEl.textContent = reason;
    if (modal) modal.hidden = false;
  }

  function hideUpgradeModal() {
    const modal = document.getElementById('upgrade-modal');
    if (modal) modal.hidden = true;
  }

  function initUpgradeUI() {
    const closeBtn = document.getElementById('upgrade-close');
    if (closeBtn) closeBtn.onclick = hideUpgradeModal;

    const backdrop = document.getElementById('upgrade-modal');
    if (backdrop) backdrop.onclick = (e) => { if (e.target === backdrop) hideUpgradeModal(); };

    // Plan buttons — open email contact
    document.querySelectorAll('.upgrade-plan-btn').forEach((btn) => {
      btn.onclick = () => {
        const plan = btn.dataset.plan;
        const subject = encodeURIComponent('NghienDe Upgrade — ' + plan);
        const body = encodeURIComponent('Hi, I want to upgrade to the ' + plan + ' plan.\n\nEmail: ' + (ShadowAuth.getUser()?.email || ''));
        window.open('mailto:contact@spiragiving.dev?subject=' + subject + '&body=' + body, '_blank');
      };
    });

    // btn-upgrade in menu
    const upgradeMenuBtn = document.getElementById('btn-upgrade');
    if (upgradeMenuBtn) upgradeMenuBtn.onclick = () => {
      const slideMenu = document.getElementById('slide-menu');
      const menuOverlay = document.getElementById('menu-overlay');
      if (slideMenu) slideMenu.hidden = true;
      if (menuOverlay) menuOverlay.hidden = true;
      showUpgradeModal('Nâng cấp để có nhiều lượt dịch và AI hơn mỗi ngày.');
    };
  }

  // ===== 🎵 WAVEFORM VISUALIZER =====
  let waveAnimFrame = null;
  let waveActive = false;
  let waveMicLevel = 0; // updated by ShadowMic level listener
  const waveHistory = new Float32Array(70).fill(0);

  function startWaveform() {
    waveActive = true;
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, mid = H / 2;

    function draw() {
      if (!waveActive) return;
      ctx.clearRect(0, 0, W, H);
      // Shift history
      for (let i = 0; i < waveHistory.length - 1; i++) waveHistory[i] = waveHistory[i + 1];
      // Use real mic level + subtle animation when silent
      const live = waveMicLevel > 0.05 ? waveMicLevel : 0.04 + Math.sin(Date.now() / 400) * 0.03;
      waveHistory[waveHistory.length - 1] = Math.min(1, live + Math.random() * 0.05);

      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#1a73e8');
      grad.addColorStop(0.5, '#34a853');
      grad.addColorStop(1, '#1a73e8');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const step = W / waveHistory.length;
      waveHistory.forEach((v, i) => {
        const x = i * step;
        const y = mid + Math.sin(i * 0.4 + Date.now() / 200) * v * (mid - 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      waveAnimFrame = requestAnimationFrame(draw);
    }
    draw();
  }

  function stopWaveform() {
    waveActive = false;
    waveMicLevel = 0;
    if (waveAnimFrame) { cancelAnimationFrame(waveAnimFrame); waveAnimFrame = null; }
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw flat line
    ctx.strokeStyle = '#dadce0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  // ===== 📚 FLASHCARD SRS (SM-2 simplified) =====
  const FLASH_KEY = 'se_flashcards_v1';
  let flashCards = [];
  let currentFlashIdx = 0;
  let flashRevealed = false;

  async function loadFlashCards() {
    // Get favorites from content script (source of truth), fall back to cache
    let favs = favorites; // `favorites` is updated from content script via getState()
    if (!favs || !favs.length) {
      const r2 = await cmd('vocab');
      favs = (r2 && r2.savedWords) ? r2.savedWords.map(w => ({ text: w.word, trans: w.context || '' })) : [];
    }
    const r = await chrome.storage.local.get(FLASH_KEY);
    const srsData = r[FLASH_KEY] || {};

    flashCards = favs.map((fav) => {
      const srs = srsData[fav.text] || { interval: 1, ease: 2.5, due: 0, reviews: 0 };
      return { text: fav.text, trans: fav.trans || '', srs };
    });

    // Sort: due first, then by due date ascending
    const now = Date.now();
    flashCards.sort((a, b) => {
      const aDue = a.srs.due <= now;
      const bDue = b.srs.due <= now;
      if (aDue && !bDue) return -1;
      if (!aDue && bDue) return 1;
      return a.srs.due - b.srs.due;
    });

    currentFlashIdx = 0;
    flashRevealed = false;
    renderFlash();
  }

  async function gradeFlash(quality) { // quality: 0=hard, 3=good, 5=skip
    if (!flashCards.length) return;
    const card = flashCards[currentFlashIdx];
    if (!card) return;

    if (quality !== 5) {
      const srs = card.srs;
      if (quality === 0) { // Hard
        srs.interval = Math.max(1, Math.round(srs.interval * 0.5));
        srs.ease = Math.max(1.3, srs.ease - 0.2);
      } else { // Good
        srs.interval = Math.round(srs.interval * srs.ease);
        srs.ease = Math.min(2.5 + 0.15, srs.ease + 0.1);
      }
      srs.due = Date.now() + srs.interval * 86400000;
      srs.reviews = (srs.reviews || 0) + 1;

      // Persist SRS data
      const r = await chrome.storage.local.get(FLASH_KEY);
      const all = r[FLASH_KEY] || {};
      all[card.text] = srs;
      await chrome.storage.local.set({ [FLASH_KEY]: all });
    }

    // Next card
    currentFlashIdx = (currentFlashIdx + 1) % flashCards.length;
    flashRevealed = false;
    renderFlash();
  }

  // ===== 📊 SESSION STATS MODAL =====
  function showSessionStats() {
    const { sessionSentences, sessionScores, sessionXp, streak } = streakData;
    if (!sessionSentences) return;
    const avg = sessionScores.length ? Math.round(sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length) : 0;
    const best = sessionScores.length ? Math.max(...sessionScores) : 0;
    const ss = $('#stat-sentences'); if (ss) ss.textContent = sessionSentences;
    const sa = $('#stat-avg-score'); if (sa) sa.textContent = avg ? avg + '%' : '—';
    const sb = $('#stat-best'); if (sb) sb.textContent = best ? best + '%' : '—';
    const sx = $('#stat-xp-earned'); if (sx) sx.textContent = '+' + sessionXp + ' XP';
    const sm = $('#stat-streak-msg'); if (sm) {
      sm.textContent = streak >= 7 ? '🔥 ' + streak + ' day streak! Incredible!' :
                       streak >= 3 ? '🔥 ' + streak + ' day streak! Keep going!' :
                       streak === 1 ? 'Day 1! Start a streak!' : 'Great session!';
    }
    const modal = $('#session-modal'); if (modal) modal.hidden = false;
  }

  function resetSessionStats() {
    streakData.sessionXp = 0;
    streakData.sessionScores = [];
    streakData.sessionSentences = 0;
  }

  // ===== 🔍 SUBTITLE SEARCH =====
  let searchQuery = '';
  function filterSentences() {
    if (!searchQuery && statusFilter === 'all') return sentences;
    return sentences.filter((s, i) => {
      const matchSearch = !searchQuery || s.text.toLowerCase().includes(searchQuery.toLowerCase()) || (s.trans || '').toLowerCase().includes(searchQuery.toLowerCase());
      const status = getSentStatus(s.text);
      const matchFilter = statusFilter === 'all' || status === statusFilter || (statusFilter === 'new' && status === 'unseen');
      return matchSearch && matchFilter;
    });
  }

  // ===== GĐ2: chép chính tả (dictation) =====
  function norm(t) { return (t || '').toLowerCase().replace(/[^a-zäöüß0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean); }
  function startDictation() {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    speakText(s.text);
    const box = $('#dictbox'); box.hidden = false;
    box.innerHTML = '<div style="font-size:12px;color:#8b94a6">✍️ Nghe và gõ lại câu (không nhìn phụ đề):</div>' +
      '<textarea id="dictin" placeholder="Gõ những gì bạn nghe được…"></textarea>' +
      '<div class="drow"><button class="btn" id="dictplay">🔊 Nghe lại</button><button class="btn mic" id="dictcheck">Kiểm tra</button><button class="btn" id="dictclose">Đóng</button></div>' +
      '<div class="res" id="dictres"></div>';
    $('#dictin').focus();
    $('#dictplay').onclick = () => speakText(s.text);
    $('#dictclose').onclick = () => { box.hidden = true; };
    $('#dictcheck').onclick = () => {
      const ref = norm(s.text), hyp = norm($('#dictin').value);
      const hset = hyp.slice();
      const html = ref.map((w) => { const i = hset.indexOf(w); if (i >= 0) { hset.splice(i, 1); return '<span class="fw correct">' + w + '</span>'; } return '<span class="fw missing">' + w + '</span>'; }).join(' ');
      const correct = ref.filter((w) => hyp.includes(w)).length;
      $('#dictres').innerHTML = '<b>' + Math.round(correct / (ref.length || 1) * 100) + '%</b> đúng<br>' + html;
    };
  }

  // ===== GĐ2: Flashcard SRS (legacy pane — kept for tab compatibility) =====
  const SRS_KEY = 'sd_srs_v1';
  function srsGet() { return new Promise((res) => { try { chrome.storage.local.get(SRS_KEY, (r) => res((r && r[SRS_KEY]) || {})); } catch (e) { res({}); } }); }
  function srsSet(d) { return new Promise((res) => { try { chrome.storage.local.set({ [SRS_KEY]: d }, res); } catch (e) { res(); } }); }
  const DAY = 86400000;

  function renderFlash() {
    const info = document.getElementById('flash-info');
    const front = document.getElementById('flash-front');
    const back = document.getElementById('flash-back');
    const hardBtn = document.getElementById('btn-hard');
    const goodBtn = document.getElementById('btn-good');
    const skipBtn = document.getElementById('btn-skip');

    if (!front) return;

    if (!flashCards.length) {
      if (info) info.innerHTML = '<div class="flash-empty">⭐ Thêm câu yêu thích để bắt đầu luyện flashcard!</div>';
      front.textContent = '';
      if (back) back.hidden = true;
      if (hardBtn) hardBtn.disabled = true;
      if (goodBtn) goodBtn.disabled = true;
      return;
    }

    const card = flashCards[currentFlashIdx];
    const now = Date.now();
    const isDue = card.srs.due <= now;
    const dueInDays = Math.max(0, Math.round((card.srs.due - now) / 86400000));

    if (info) {
      const badge = isDue
        ? '<span class="flash-srs-badge flash-srs-badge--due">Due now</span>'
        : card.srs.reviews === 0
          ? '<span class="flash-srs-badge flash-srs-badge--new">New</span>'
          : '<span class="flash-srs-badge flash-srs-badge--ok">Due in ' + dueInDays + 'd</span>';
      info.innerHTML = (currentFlashIdx + 1) + ' / ' + flashCards.length + badge;
    }

    front.textContent = card.text;
    if (back) {
      back.textContent = card.trans || '(no translation)';
      back.hidden = !flashRevealed;
    }

    if (hardBtn) hardBtn.disabled = false;
    if (goodBtn) goodBtn.disabled = false;

    // Tap to reveal
    const flashCardEl = document.querySelector('.flash-card');
    if (flashCardEl) {
      flashCardEl.onclick = () => {
        flashRevealed = true;
        if (back) back.hidden = false;
      };
    }
  }


  // ===== Đọc mẫu theo ngôn ngữ học =====
  const BCP = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ru: 'ru-RU', nl: 'nl-NL' };
  function speakText(t) { cmd('speak', { text: t, rate: settings.rate, lang: BCP[settings.targetLang] || 'de-DE' }); }

  // ===== i18n (vi/en) =====
  const I18N = {
    vi: { tab_practice:'Luyện', tab_vocab:'Từ vựng', tab_flash:'Thẻ', tab_progress:'Tiến độ',
      nohost:'Mở một video YouTube hoặc Netflix rồi quay lại đây.',
      ob_title:'Bắt đầu nhanh', ob1:'Mở video tiếng Đức trên YouTube.', ob2:'Bấm "Phụ đề tự động" (hoặc nạp file SRT/VTT).', ob3:'Bấm "Bật mic", cho phép micro cho extension.', ob4:'Bấm một câu → nói lại → xem điểm.', ob_close:'Đã hiểu',
      src_auto:'Lấy phụ đề', src_live:'Bắt trực tiếp', src_file:'Mở file', src_mic:'Bật mic', src_diag:'Kiểm tra',
      status_init:'Mở video, lấy phụ đề để bắt đầu.',
      set_speed:'Tốc độ', set_rep:'Lặp', set_autonext:'Auto next', set_autorec:'Auto ghi âm', set_vsubs:'Phụ đề trên video', set_engine:'Engine', set_silero:'Silero VAD', set_offset:'Offset', set_target:'Học', set_native:'Dịch sang', set_uilang:'Ngôn ngữ', set_server:'Server', set_deepl:'DeepL key', set_orkey:'OpenRouter key',
      t_prev:'Câu trước', t_play:'Phát/Dừng', t_loop:'Lặp 1 câu', t_next:'Câu sau', t_shadow:'Luyện', t_listen:'Nghe mẫu', t_dict:'Chép chính tả', t_cloze:'Điền chỗ trống', t_blur:'Ẩn chữ (tự kiểm tra)', kbd_hint:'⌨ Space: nói · ◀ ▶: câu · ▲ ▼: tốc độ · R: nghe · L: lặp · B: ẩn chữ',
      fav_run:'▶️ Tự luyện dòng ⭐', stop:'⏹ Dừng', finalize:'✅ Tôi nói xong → chấm' },
    en: { tab_practice:'Practice', tab_vocab:'Words', tab_flash:'Cards', tab_progress:'Progress',
      nohost:'Open a YouTube or Netflix video, then come back here.',
      ob_title:'Quick start', ob1:'Open a German video on YouTube.', ob2:'Click "Auto subtitles" (or load an SRT/VTT file).', ob3:'Click "Enable mic" and allow microphone access for the extension.', ob4:'Click a line → speak it back → see your score.', ob_close:'Got it',
      src_auto:'Get subtitles', src_live:'Live capture', src_file:'Open file', src_mic:'Enable mic', src_diag:'Self-test',
      status_init:'Open a video and load subtitles to begin.',
      set_speed:'Speed', set_rep:'Repeat', set_autonext:'Auto next', set_autorec:'Auto record', set_vsubs:'Subtitles on video', set_engine:'Engine', set_silero:'Silero VAD', set_offset:'Offset', set_target:'Learn', set_native:'Translate to', set_uilang:'Language', set_server:'Server', set_deepl:'DeepL key', set_orkey:'OpenRouter key',
      t_prev:'Previous', t_play:'Play/Pause', t_loop:'Loop one', t_next:'Next', t_shadow:'Practice', t_listen:'Listen', t_dict:'Dictation', t_cloze:'Fill blanks', t_blur:'Hide text (self-test)', kbd_hint:'⌨ Space: speak · ◀ ▶: line · ▲ ▼: speed · R: listen · L: loop · B: hide',
      fav_run:'▶️ Practice ⭐ lines', stop:'⏹ Stop', finalize:'✅ Done speaking → score' },
  };
  function setText(el, txt) {
    if (el.children.length === 0) { el.textContent = txt; return; }
    const n = el.firstChild;
    if (n && n.nodeType === 3) n.nodeValue = txt; else el.insertBefore(document.createTextNode(txt), el.firstChild);
  }
  function applyI18n(lang) {
    const d = I18N[lang] || I18N.vi;
    document.querySelectorAll('[data-i18n]').forEach((el) => { const k = el.dataset.i18n; if (d[k]) setText(el, d[k]); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { const k = el.dataset.i18nTitle; if (d[k]) el.title = d[k]; });
  }

  // ===== Onboarding =====
  function maybeOnboard() {
    try { if (!localStorage.getItem('sd_onboarded')) $('#onboard').hidden = false; } catch (e) {}
    const c = $('#obclose'); if (c) c.onclick = () => { $('#onboard').hidden = true; try { localStorage.setItem('sd_onboarded', '1'); } catch (e) {} };
  }

  // ===== Self-test / chẩn đoán =====
  async function runDiag() {
    const box = $('#diagbox'); box.hidden = false; box.innerHTML = '⏳ Đang kiểm tra…';
    const r = await cmd('diag');
    if (!r || !r.ok) { box.innerHTML = '<b class="bad">✗ Không kết nối được content script.</b> Mở/tải lại tab YouTube hoặc Netflix.'; return; }
    try { const p = await chrome.runtime.sendMessage({ sd: 'mic-service', action: 'permission' }); if (p && p.ok) r.mic = p.state; } catch (e) {}
    const row = (ok, label, val) => '<div class="drow2"><span class="' + (ok ? 'gook' : 'gobad') + '">' + (ok ? '✓' : '✗') + '</span> ' + label + (val != null ? ': <b>' + val + '</b>' : '') + '</div>';
    box.innerHTML =
      row(true, 'Trang', r.host) +
      row(r.video, 'Tìm thấy &lt;video&gt;') +
      row(r.sentences > 0, 'Phụ đề đã nạp', r.sentences + ' câu') +
      row(r.mic === 'granted', 'Quyền micro của extension', r.mic) +
      row(r.engine, 'Engine sẵn sàng') +
      row(r.vsubs, 'Overlay phụ đề video') +
      row(r.tracklist, 'Tracklist YouTube') +
      (r.mic !== 'granted' ? '<div class="hintline">→ Bấm 🎤 Bật mic để cấp quyền.</div>' : '') +
      (r.sentences === 0 ? '<div class="hintline">→ Bấm 📥 Lấy phụ đề / 🔴 Bắt trực tiếp / 📂 Mở file.</div>' : '');
  }

  // ===== Fill-in-the-blank (cloze) =====
  function startCloze() {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    const toks = s.text.split(/(\s+)/);
    const idxBlank = [];
    toks.forEach((w, i) => { const clean = w.replace(/[^A-Za-zäöüÄÖÜß]/g, ''); if (clean.length >= 4 && Math.random() < 0.4) idxBlank.push(i); });
    if (!idxBlank.length && toks.length) idxBlank.push(toks.findIndex((w) => w.trim().length >= 4));
    const box = $('#dictbox'); box.hidden = false;
    let html = '<div style="font-size:12px;color:#8b94a6">🧩 Điền từ còn thiếu (nghe để gợi ý):</div><div class="res" style="margin:8px 0">';
    toks.forEach((w, i) => {
      if (idxBlank.includes(i)) html += '<input class="cz" data-ans="' + w.replace(/"/g, '') + '" size="' + Math.max(3, w.length) + '">';
      else html += w.replace(/</g, '&lt;');
    });
    html += '</div><div class="drow"><button class="btn" id="czplay">🔊 Nghe</button><button class="btn mic" id="czcheck">Kiểm tra</button><button class="btn" id="czclose">Đóng</button></div><div class="res" id="czres"></div>';
    box.innerHTML = html;
    $('#czplay').onclick = () => speakText(s.text);
    $('#czclose').onclick = () => { box.hidden = true; };
    $('#czcheck').onclick = () => {
      let ok = 0, tot = 0;
      box.querySelectorAll('.cz').forEach((inp) => {
        tot++; const ans = (inp.dataset.ans || '').toLowerCase().replace(/[^a-zäöüß]/g, '');
        const got = (inp.value || '').toLowerCase().replace(/[^a-zäöüß]/g, '');
        const good = ans === got; if (good) ok++;
        inp.style.borderColor = good ? '#15803d' : '#b91c1c'; if (!good) inp.value = inp.dataset.ans;
      });
      $('#czres').innerHTML = '<b>' + ok + '/' + tot + '</b> đúng.';
    };
  }

  // ===== ShadowEcho-style UI wiring =====

  // View switching (auth | list | practice | onboard)
  function showView(name) {
    const va = $('#view-auth'), vl = $('#view-list'), vp = $('#view-practice'), vo = $('#view-onboard');
    if (va) va.hidden = name !== 'auth';
    if (vl) vl.hidden = name !== 'list';
    if (vp) vp.hidden = name !== 'practice';
    if (vo) vo.hidden = name !== 'onboard';
  }

  // Source info update
  function updateSourceInfo(idx) {
    const el = $('#source-info-label'); if (!el) return;
    const total = sentences.length;
    const i = (idx != null ? idx : current);
    el.textContent = total ? ('Line ' + (i + 1) + ' of ' + total) : '';
  }

  // Practice view: switch to sentence and show practice pane
  function openPractice(i) {
    showView('practice');
    updateSourceInfo(i);
    // Update next sentence preview
    const next = sentences[i + 1];
    const nextEl = $('#next-text'); if (nextEl) nextEl.textContent = next ? next.text : '';
  }


  // Slide-in menu
  function openMenu() { const m = $('#slide-menu'), o = $('#menu-overlay'); if (m) m.hidden = false; if (o) o.hidden = false; }
  function closeMenu() { const m = $('#slide-menu'), o = $('#menu-overlay'); if (m) m.hidden = true; if (o) o.hidden = true; }
  { const b = $('#btn-open-menu'); if (b) b.onclick = openMenu; }
  { const b = $('#btn-menu'); if (b) b.onclick = openMenu; }
  { const b = $('#btn-menu-close'); if (b) b.onclick = closeMenu; }
  { const o = $('#menu-overlay'); if (o) o.onclick = closeMenu; }

  // Back button
  { const b = $('#btn-back-to-list'); if (b) b.onclick = () => showView('list'); }

  // Toolbar buttons wiring
  { const b = $('#btn-play-pause'); if (b) b.onclick = () => cmd('togglePlay', { target: settings.targetLang, native: settings.nativeLang }); }
  { const b = $('#btn-shadow'); if (b) b.onclick = () => { showRecordPanel(true); startShadow(current); }; }
  { const b = $('#btn-prev'); if (b) b.onclick = () => cmd('prev'); }
  { const b = $('#btn-next'); if (b) b.onclick = () => { cmd('next'); if (sentences[current + 1]) openPractice(current + 1); }; }
  { const b = $('#btn-dictation'); if (b) b.onclick = () => startDictation(); }
  { const b = $('#btn-cloze'); if (b) b.onclick = () => startCloze(); }
  { const b = $('#btn-hint'); if (b) b.onclick = () => { const s = sentences[current]; if (s && s.trans) setStatus(s.trans, 'ok'); else if (s) translateText(s.text, settings.targetLang, settings.nativeLang).then((t) => { if (t) { s.trans = t; setStatus(t, 'ok'); } }); }; }
  { const b = $('#btn-shadow-fav'); if (b) b.onclick = async () => { if (!settings.autoRecord || await enableMic({ silent: true })) cmd('shadowFav', { target: settings.targetLang, native: settings.nativeLang }); }; }
  { const b = $('#btn-blur'); if (b) b.onclick = toggleBlur; }
  { const b = $('#btn-listen'); if (b) b.onclick = () => { const s = sentences[current]; if (s) speakText(s.text); }; }
  { const b = $('#btn-load-auto'); if (b) b.onclick = () => cmd('loadAuto', { target: settings.targetLang, native: settings.nativeLang }); }
  { const b = $('#btn-load-live'); if (b) b.onclick = async () => { const r = await cmd('live'); if (r) b.classList.toggle('on', !!r.running); }; }

  // The "Luyện câu này" (ShadowEcho-style): Nghe mẫu / Nói & chấm / Câu sau
  { const b = $('#try-card-listen'); if (b) b.onclick = () => { const s = sentences[current]; if (s) { cmd('select', { i: current }); speakText(s.text); } }; }
  { const b = $('#try-card-speak'); if (b) b.onclick = () => { if (!sentences.length) return; openPractice(current); showRecordPanel(true); startShadow(current); }; }
  { const b = $('#try-card-next'); if (b) b.onclick = () => { if (current + 1 < sentences.length) selectRow(current + 1); }; }

  // Record panel
  function showRecordPanel(show) { const p = $('#record-panel'); if (p) p.hidden = !show; }
  { const b = $('#btn-record-close'); if (b) b.onclick = () => showRecordPanel(false); }
  { const b = $('#btn-how-to-improve'); if (b) b.onclick = () => { const s = sentences[current]; if (s) translateText(s.text, settings.targetLang, settings.nativeLang).then((t) => setStatus(t || 'No translation', 'ok')); }; }

  // Queue Complete modal
  { const b = $('#modal-close'); if (b) b.onclick = () => { const m = $('#modal-backdrop'); if (m) m.hidden = true; }; }
  { const b = $('#modal-practice-again'); if (b) b.onclick = () => { const m = $('#modal-backdrop'); if (m) m.hidden = true; showView('list'); cmd('loadAuto', { target: settings.targetLang, native: settings.nativeLang }); }; }

  // Info banner dismiss
  { const b = $('#info-banner-dismiss'); if (b) b.onclick = () => { const el = $('#info-banner'); if (el) el.hidden = true; try { localStorage.setItem('se_banner_dismissed', '1'); } catch (e) {} }; }
  { const b = $('#info-banner-close'); if (b) b.onclick = () => { const el = $('#info-banner'); if (el) el.hidden = true; }; }
  try { if (localStorage.getItem('se_banner_dismissed')) { const el = $('#info-banner'); if (el) el.hidden = true; } } catch (e) {}

  // ===== Auth UI wiring =====
  function showAuthForm(name) {
    ['auth-form-login', 'auth-form-register', 'auth-form-forgot'].forEach((id) => {
      const el = $('#' + id); if (el) el.hidden = id !== name;
    });
  }
  function setAuthMsg(id, msg, type) {
    const el = $('#' + id); if (!el) return;
    el.textContent = msg;
    el.className = 'auth-message auth-message--' + (type || 'error');
    el.hidden = !msg;
  }

  // Switch forms
  { const b = $('#btn-show-register'); if (b) b.onclick = (e) => { e.preventDefault(); showAuthForm('auth-form-register'); }; }
  { const b = $('#btn-show-login');    if (b) b.onclick = (e) => { e.preventDefault(); showAuthForm('auth-form-login'); }; }
  { const b = $('#btn-show-forgot');   if (b) b.onclick = (e) => { e.preventDefault(); showAuthForm('auth-form-forgot'); }; }
  { const b = $('#btn-back-to-login'); if (b) b.onclick = (e) => { e.preventDefault(); showAuthForm('auth-form-login'); }; }

  // Login
  { const b = $('#btn-login'); if (b) b.onclick = async () => {
    const email = ($('#auth-email') || {}).value || '';
    const pw    = ($('#auth-password') || {}).value || '';
    if (!email || !pw) { setAuthMsg('auth-login-error', 'Vui lòng nhập email và mật khẩu.'); return; }
    b.disabled = true; b.textContent = 'Đang đăng nhập…';
    try {
      await ShadowAuth.signIn(email, pw);
    } catch (e) {
      setAuthMsg('auth-login-error', e.message || 'Đăng nhập thất bại.');
    } finally { b.disabled = false; b.textContent = 'Đăng nhập'; }
  }; }

  // Register
  { const b = $('#btn-register'); if (b) b.onclick = async () => {
    const email = ($('#auth-reg-email') || {}).value || '';
    const pw    = ($('#auth-reg-password') || {}).value || '';
    if (!email || !pw) { setAuthMsg('auth-reg-error', 'Vui lòng nhập đầy đủ thông tin.'); return; }
    if (pw.length < 6) { setAuthMsg('auth-reg-error', 'Mật khẩu tối thiểu 6 ký tự.'); return; }
    b.disabled = true; b.textContent = 'Đang tạo tài khoản…';
    try {
      await ShadowAuth.signUp(email, pw);
      setAuthMsg('auth-reg-success', '✓ Tài khoản đã tạo! Kiểm tra email để xác nhận rồi đăng nhập.', 'success');
      setAuthMsg('auth-reg-error', '');
    } catch (e) {
      setAuthMsg('auth-reg-error', e.message || 'Đăng ký thất bại.');
    } finally { b.disabled = false; b.textContent = 'Tạo tài khoản'; }
  }; }

  // Forgot password
  { const b = $('#btn-forgot-send'); if (b) b.onclick = async () => {
    const email = ($('#auth-forgot-email') || {}).value || '';
    if (!email) { setAuthMsg('auth-forgot-error', 'Nhập email của bạn.'); return; }
    b.disabled = true; b.textContent = 'Đang gửi…';
    try {
      await ShadowAuth.resetPassword(email);
      setAuthMsg('auth-forgot-success', '✓ Email đặt lại mật khẩu đã được gửi. Kiểm tra hộp thư của bạn.', 'success');
      setAuthMsg('auth-forgot-error', '');
    } catch (e) {
      setAuthMsg('auth-forgot-error', e.message || 'Không thể gửi email.');
    } finally { b.disabled = false; b.textContent = 'Gửi email đặt lại'; }
  }; }

  // Logout
  { const b = $('#btn-logout'); if (b) b.onclick = async () => {
    await ShadowAuth.signOut();
  }; }

  // Account UI updater
  function updateAccountUI(user, profile) {
    const emailEl = $('#account-email'); if (emailEl) emailEl.textContent = (user && user.email) || '—';
    const planEl  = $('#account-plan-badge');
    if (planEl) {
      const plan = (profile && profile.plan) || 'free';
      const names = { free: 'Free', basic: 'Basic', pro: 'Pro', lifetime: 'Lifetime' };
      planEl.textContent = names[plan] || plan;
      planEl.className = 'account-plan-badge plan-' + plan;
    }
  }

  async function updateUsageUI(profile) {
    if (!profile || !profile.usage) return;
    const { translations, ai } = profile.usage;
    const tPct = Math.min(100, Math.round((translations.used / (translations.limit || 1)) * 100));
    const aPct = Math.min(100, Math.round((ai.used / (ai.limit || 1)) * 100));
    const tc = $('#usage-trans-count'); if (tc) tc.textContent = translations.used + ' / ' + translations.limit;
    const ac = $('#usage-ai-count');    if (ac) ac.textContent = ai.used + ' / ' + ai.limit;
    const tb = $('#usage-trans-bar');   if (tb) tb.style.width = tPct + '%';
    const ab = $('#usage-ai-bar');      if (ab) ab.style.width = aPct + '%';
  }

  // Vocab/flashcard sections in slide menu
  { const s = document.getElementById('section-vocab'); if (s) s.addEventListener('toggle', () => { if (s.open) loadVocab('vocab'); }); }
  { const s = document.getElementById('section-flash'); if (s) s.addEventListener('toggle', () => { if (s.open) loadFlashCards(); }); }
  { const h = document.getElementById('btn-hard'); if (h) h.onclick = () => gradeFlash(0); }
  { const g = document.getElementById('btn-good'); if (g) g.onclick = () => gradeFlash(3); }
  { const sk = document.getElementById('btn-skip'); if (sk) sk.onclick = () => gradeFlash(5); }
  { const s = document.getElementById('section-progress'); if (s) s.addEventListener('toggle', () => { if (s.open) loadVocab('progress'); }); }
  // Anki buttons in menu
  { const b = $('#anki-export'); if (b) b.onclick = exportAnki; }
  { const b = $('#anki-sync'); if (b) b.onclick = exportAnkiConnect; }

  // ===== New feature wiring =====

  // Dark mode toggle
  { const b = $('#btn-dark-mode'); if (b) b.onclick = () => { applyDarkMode(!document.body.classList.contains('dark')); }; }

  // Keyboard overlay
  { const b = $('#kbd-close'); if (b) b.onclick = () => { const o = $('#kbd-overlay'); if (o) o.hidden = true; }; }
  document.addEventListener('click', (e) => {
    const overlay = $('#kbd-overlay');
    if (overlay && !overlay.hidden && e.target === overlay) overlay.hidden = true;
  });

  // Session stats modal
  { const b = $('#session-modal-close'); if (b) b.onclick = () => { const m = $('#session-modal'); if (m) m.hidden = true; }; }
  { const b = $('#session-modal-continue'); if (b) b.onclick = () => {
    const m = $('#session-modal'); if (m) m.hidden = true;
    resetSessionStats(); saveStreak();
    showView('list');
  }; }

  // Search input
  { const inp = $('#search-input'); if (inp) {
    inp.addEventListener('input', () => { searchQuery = inp.value; renderList(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { inp.value = ''; searchQuery = ''; renderList(); inp.blur(); } });
  }; }

  // Status filter buttons
  document.querySelectorAll('.sf-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.sf-btn').forEach((b) => b.classList.remove('sf-btn--active'));
      btn.classList.add('sf-btn--active');
      statusFilter = btn.dataset.sf || 'all';
      renderList();
    };
  });

  // ===== Auth state handler =====
  if (typeof ShadowAuth !== 'undefined') {
    ShadowAuth.onAuthStateChange(async (user) => {
      if (user) {
        // Logged in → check if first-time user → show onboarding
        const onboarded = await checkOnboarding();
        if (!onboarded) {
          showView('onboard');
        } else {
          showView('list');
        }
        updateAccountUI(user, null);
        // Fetch full profile in background
        fetchMe().then((profile) => {
          updateAccountUI(user, profile);
          updateUsageUI(profile);
        });
        refresh();
      } else {
        // Not logged in → show auth
        showView('auth');
        showAuthForm('auth-form-login');
      }
    });

    // Init: restore session
    ShadowAuth.init().then((session) => {
      if (!session) { showView('auth'); showAuthForm('auth-form-login'); }
      // If session exists, onAuthStateChange fires automatically
    });
  } else {
    showView('list');
  }

  // ===== Hiển thị cấu hình máy + model Whisper đã chọn =====
  async function updateHwInfo() {
    const el = $('#hwInfo'); if (!el) return;
    if (!window.ShadowMic || !window.ShadowMic.detectHardware) { el.textContent = ''; return; }
    try {
      const avail = await window.ShadowMic.isWhisperAvailable();
      const st = window.ShadowMic.whisperStatus ? window.ShadowMic.whisperStatus(settings.whisperModel) : null;
      const hw = (st && st.hw) || window.ShadowMic.detectHardware();
      const sel = window.ShadowMic.pickWhisperModel(settings.whisperModel);
      const memTxt = hw.mem >= 8 ? '8GB+' : hw.mem + 'GB';
      if (settings.engine !== 'whisper') {
        el.textContent = '🖥️ ' + memTxt + ' RAM · ' + hw.cores + ' nhân CPU';
      } else if (!avail) {
        el.textContent = '⚠️ Thiếu thư viện Whisper (vendor/) — đang dùng Web Speech tạm. Xem README.';
      } else if (st && st.upgrading && st.active) {
        // Đang dùng model nhỏ, nâng lên model phù hợp máy ở nền.
        el.textContent = '🖥️ ' + memTxt + ' RAM · ' + hw.cores + ' nhân → Whisper ' + st.active.toUpperCase() +
          ' (đang nâng lên ' + sel.short.toUpperCase() + '…)';
      } else {
        el.textContent = '🖥️ ' + memTxt + ' RAM · ' + hw.cores + ' nhân → Whisper ' + sel.short.toUpperCase() + ' (' + sel.label + ')';
      }
    } catch (_) { el.textContent = ''; }
  }

  // ===== Init =====
  if (window.ShadowMic) {
    window.ShadowMic.setLevelListener((level) => {
      waveMicLevel = level; // feed real level into waveform
      const meter = $('#micLevel'); if (meter) meter.style.transform = 'scaleY(' + Math.max(.08, level).toFixed(2) + ')';
    });
    window.ShadowMic.setProgressListener((status, pct) => onProgress({ status, pct }));
    // Nạp sẵn model Whisper khi mở panel: tiny trước (dùng ngay) -> nâng lên model
    // phù hợp máy ở nền. Refresh UI vài lần để hiện trạng thái khi nâng cấp xong.
    if (settings.engine === 'whisper' && window.ShadowMic.warmupWhisper) {
      window.ShadowMic.warmupWhisper(settings.whisperModel);
      let n = 0; const hwTimer = setInterval(() => { updateHwInfo(); if (++n >= 20) clearInterval(hwTimer); }, 1500);
    }
    updateHwInfo();
  }
  // Nut "Toi noi xong -> cham ngay": dung ghi am tuc thi nhung van cham diem
  {
    const fbtn = $('#finalizeBtn');
    if (fbtn) fbtn.onclick = () => { try { window.ShadowMic && window.ShadowMic.finalizeRecording(); } catch (e) {} pageMicSignal('finalize'); fbtn.hidden = true; setStatus('🧮 Đang chấm…'); };
  }
  // Nut an/mo chu
  { const bb = $('#blurBtn'); if (bb) bb.onclick = toggleBlur; }

  // ===== Phim tat (keyboard-first, kieu ShadowEcho) =====
  function isTyping(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) return;
    switch (e.code) {
      case 'Space': // ghi am cau hien tai / dung & cham neu dang ghi
        e.preventDefault();
        if (recState === 'recording') { try { window.ShadowMic && window.ShadowMic.finalizeRecording(); } catch (_) {} pageMicSignal('finalize'); const fb = $('#finalizeBtn'); if (fb) fb.hidden = true; }
        else startShadow(current);
        break;
      case 'ArrowLeft': e.preventDefault(); cmd('prev'); break;
      case 'ArrowRight': e.preventDefault(); cmd('next'); break;
      case 'ArrowUp': e.preventDefault(); changeRate(+1); break;
      case 'ArrowDown': e.preventDefault(); changeRate(-1); break;
      case 'Enter': e.preventDefault(); cmd('togglePlay'); break;
      case 'KeyR': e.preventDefault(); { const s = sentences[current]; if (s) speakText(s.text); } break; // nghe mau
      case 'KeyL': e.preventDefault(); cmd('loop').then((r) => { if (r) { const b = $('#loop'); if (b) b.classList.toggle('on', !!r.loop); } }); break;
      case 'KeyB': e.preventDefault(); toggleBlur(); break;
      case 'KeyS': case 'Escape': e.preventDefault(); try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (_) {} pageMicSignal('abort'); cmd('stop'); break;
      case 'KeyM': e.preventDefault(); openMenu(); break;
      case 'Slash': if (e.shiftKey) { e.preventDefault(); const o = $('#kbd-overlay'); if (o) o.hidden = !o.hidden; } break;
      default: break;
    }
  });
  // Load persistent data
  loadStreak();
  loadSentStatus();
  loadDarkMode();
  initOnboardingUI();
  initUpgradeUI();

  maybeOnboard();
  connectPort();
  // refresh() is called by auth state handler after login; skip here to avoid duplicate
  if (typeof ShadowAuth === 'undefined') refresh();
})();
