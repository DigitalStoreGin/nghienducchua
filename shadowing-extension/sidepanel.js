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
  const WORKER_URL = 'https://nghienducchua-proxy.thoatran21012.workers.dev';
  let settings = { rate: 1, repeat: 3, autoNext: true, autoRecord: true, engine: 'webspeech', useSileroVad: false, offsetMs: 0, nativeLang: 'vi', targetLang: 'de', uiLang: 'vi', videoSubs: true, hideText: false, serverUrl: 'http://localhost:8000', licenseKey: '', deeplKey: '', openrouterKey: '' };
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

  async function enableMic(options) {
    const button = $('#micButton');
    try {
      if (button) { button.disabled = true; button.classList.add('pending'); }
      await window.ShadowMic.ensureMic();
      if (button) { button.classList.remove('pending'); button.classList.add('ready'); button.dataset.ready = '1'; }
      setStatus('Micro đã sẵn sàng — hãy chọn một câu và bắt đầu nói.', 'ok');
      return true;
    } catch (error) {
      if (button) button.classList.remove('pending', 'ready');
      setStatus(micErrorMessage(error), 'warn');
      if (!options || !options.silent) renderFeedback({ error: 'mic:' + ((error && error.message) || error) });
      return false;
    } finally { if (button) button.disabled = false; }
  }

  async function startShadow(i) {
    // Huy lan ghi am cu (neu dang treo) de bat dau moi -> luon co phan hoi
    try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (e) {}
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
      case 'playstate': { const b = $('.cbtn.play'); if (b) b.textContent = p.playing ? '⏸' : '▶'; break; }
      case 'loop': $('#loop').classList.toggle('on', p); break;
      case 'state': onState(p); break;
      case 'feedback': renderFeedback(p); break;
      case 'progress': onProgress(p); break;
      case 'status': setStatus(p.text, p.kind); break;
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
    // Phụ đề kép: nếu chưa có bản dịch & đã nhập license key -> tự dịch câu hiện tại
    if (!s.trans && (settings.licenseKey || '').trim()) {
      translateText(s.text, settings.targetLang || 'de', settings.nativeLang || 'vi').then((t) => {
        if (t) { s.trans = t; if ($('#nowDe').textContent === s.text) { $('#nowTr').textContent = t; if (trEl) trEl.textContent = t; } }
      });
    }
  }
  function markCur(i) { document.querySelectorAll('.row').forEach((r) => r.classList.toggle('cur', +r.dataset.i === i)); const r = document.querySelector('.row[data-i="' + i + '"]'); if (r) r.scrollIntoView({ block: 'nearest' }); }

  function isFav(t) { return favorites.some((f) => f.text === t); }
  function renderList() {
    const c = $('#list'); c.innerHTML = '';
    if (!sentences.length) { c.innerHTML = '<div class="empty">No subtitles loaded. Click Auto / Live / File above.</div>'; return; }
    sentences.forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'row' + (i === current ? ' cur' : ''); row.dataset.i = i;
      // Play button
      const playBtn = document.createElement('button'); playBtn.className = 'row-play-btn'; playBtn.textContent = '▶';
      playBtn.onclick = (e) => { e.stopPropagation(); cmd('select', { i }); openPractice(i); };
      row.appendChild(playBtn);
      // Text body
      const body = document.createElement('div'); body.className = 'row-body';
      const de = document.createElement('div'); de.className = 'de'; de.textContent = s.text;
      body.appendChild(de);
      if (s.trans) { const tr = document.createElement('div'); tr.className = 'tr'; tr.textContent = s.trans; body.appendChild(tr); }
      row.appendChild(body);
      // Action buttons (shown for current row)
      if (i === current) {
        const act = document.createElement('div'); act.className = 'act';
        const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
        const fav = mk('mini fav' + (isFav(s.text) ? ' on' : ''), isFav(s.text) ? '★' : '☆', stop(async () => { const r = await cmd('fav', { text: s.text }); if (r) { favorites = r.favorites; fav.textContent = isFav(s.text) ? '★' : '☆'; fav.classList.toggle('on', isFav(s.text)); } }));
        const listen = mk('mini', '🔊', stop(() => speakText(s.text)));
        const sh = mk('mini sh', 'Practice', stop(() => { cmd('select', { i }); openPractice(i); }));
        act.append(fav, listen, sh); row.appendChild(act);
      }
      row.onclick = () => { cmd('select', { i }); openPractice(i); };
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
      else if (/^mic|not-allowed/.test(f.error)) { m = 'Cannot access microphone.'; micFix = true; }
      else if (/empty-transcript/.test(f.error)) { m = '🤔 Nothing heard. Try speaking louder or check your mic.'; }
      box.innerHTML = '<div class="err">⚠️ ' + m + (micFix ? ' <button class="mini sh" id="micfix">🎤 Enable mic</button>' : '') + '</div>';
      if (micFix) $('#micfix').onclick = () => enableMic();
      return;
    }
    const sc = f.score;
    const g = (l, v) => { const cls = v === '—' ? '' : (v >= 80 ? 'hi' : v >= 55 ? 'mid' : 'lo'); return '<div class="gauge ' + cls + '"><b>' + v + '</b><span>' + l + '</span></div>'; };
    const words = sc.words.map((w) => '<span class="fw ' + w.status + '" title="heard: ' + esc(w.heard || '—') + '">' + esc(w.text) + '</span>').join(' ');
    box.innerHTML = '<div class="scores">' + g('Pronunc.', sc.pronunciation) + g('Fluency', sc.fluency) + g('Intonation', sc.intonation == null ? '—' : sc.intonation) + g('Overall', sc.overall) + '</div>' +
      '<div class="words">' + words + '</div><div class="heard">You said: <i>' + esc(sc.transcript || '(nothing heard)') + '</i> · ' + esc(sc.engine || '') + '</div>';
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
      if (freqOn && !window.SD_FREQ_DE.isCommon(w)) sp.classList.add('freq-rare');
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
    if (b.dataset.tab === 'flash') renderFlash();
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
      if (c === 'stop') { try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (e) {} const fb = $('#finalizeBtn'); if (fb) fb.hidden = true; }
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
  bindSetting('autorec', 'autoRecord', 'bool'); bindSetting('engine', 'engine', 'str'); bindSetting('offset', 'offsetMs', 'num');
  bindSetting('silerovad', 'useSileroVad', 'bool');
  bindSetting('target', 'targetLang', 'str'); bindSetting('native', 'nativeLang', 'str'); bindSetting('serverurl', 'serverUrl', 'str');
  bindSetting('license-key-input', 'licenseKey', 'str');
  $('#vsubs').onchange = (e) => { settings.videoSubs = e.target.checked; cmd('settings', settings); cmd('vsubs', { on: e.target.checked }); };
  $('#uilang').onchange = (e) => { settings.uiLang = e.target.value; cmd('settings', settings); applyI18n(settings.uiLang); };
  function applySettings() {
    $('#rate').value = settings.rate; $('#rep').value = settings.repeat; $('#autonext').checked = settings.autoNext;
    $('#autorec').checked = settings.autoRecord; $('#engine').value = settings.engine; $('#offset').value = settings.offsetMs;
    if ($('#silerovad')) $('#silerovad').checked = !!settings.useSileroVad;
    $('#target').value = settings.targetLang || 'de'; $('#native').value = settings.nativeLang || 'vi';
    $('#uilang').value = settings.uiLang || 'vi'; $('#vsubs').checked = settings.videoSubs !== false;
    if ($('#serverurl')) $('#serverurl').value = settings.serverUrl || 'http://localhost:8000';
    if ($('#license-key-input')) $('#license-key-input').value = settings.licenseKey || '';
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
    'meta-llama/llama-3.3-70b-instruct:free',
  ];
  const DEEPL_TGT = { vi: 'VI', en: 'EN-US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', ja: 'JA', zh: 'ZH', ko: 'KO' };
  const LANG_NAME = { vi: 'Vietnamese', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', ja: 'Japanese', zh: 'Chinese', ko: 'Korean' };

  function licenseHeader() {
    return { 'Content-Type': 'application/json', 'X-License-Key': (settings.licenseKey || '').trim() };
  }

  async function deeplTranslate(text, from, to) {
    const key = (settings.licenseKey || '').trim(); if (!key) return '';
    const tgt = DEEPL_TGT[to]; if (!tgt) return '';
    const body = { text, target_lang: tgt };
    if (DEEPL_TGT[from]) body.source_lang = DEEPL_TGT[from].split('-')[0];
    const r = await fetch(WORKER_URL + '/translate', { method: 'POST', headers: licenseHeader(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error('worker-deepl-' + r.status);
    const j = await r.json();
    return (j.translations && j.translations[0] && j.translations[0].text) || '';
  }

  async function openrouterTranslate(text, from, to, model) {
    const key = (settings.licenseKey || '').trim(); if (!key) return '';
    const r = await fetch(WORKER_URL + '/ai-translate', {
      method: 'POST',
      headers: licenseHeader(),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 500,
        messages: [
          { role: 'system', content: 'You are a professional translator. Output ONLY the translation — no quotes, no notes, no explanations.' },
          { role: 'user', content: 'Translate from ' + (LANG_NAME[from] || from) + ' to ' + (LANG_NAME[to] || to) + ':\n\n' + text },
        ],
      }),
    });
    if (!r.ok) throw new Error('worker-or-' + r.status);
    const j = await r.json();
    return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  }

  async function myMemoryTranslate(text, from, to) {
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + from + '|' + to);
    const j = await r.json();
    return (j && j.responseData && j.responseData.translatedText) || '';
  }

  async function translateText(text, from, to) {
    if (!text) return '';
    const ck = from + '|' + to + '|' + text;
    if (transCache[ck]) return transCache[ck];
    try { const d = await deeplTranslate(text, from, to); if (d) { transCache[ck] = d; return d; } } catch (e) {}
    for (const m of OR_MODELS) {
      try { const t = await openrouterTranslate(text, from, to, m); if (t) { transCache[ck] = t; return t; } } catch (e) {}
    }
    try { const t = await myMemoryTranslate(text, from, to); if (t) { transCache[ck] = t; return t; } } catch (e) {}
    return '';
  }

  // Validate license key against Worker
  async function validateLicenseKey(key) {
    if (!key || key.length < 8) return false;
    try {
      const r = await fetch(WORKER_URL + '/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-License-Key': key },
        body: JSON.stringify({ text: 'ok', target_lang: 'VI' }),
      });
      return r.status !== 401;
    } catch (e) { return false; }
  }

  const glossCache = {};
  async function fetchGloss(word) {
    if (glossCache[word]) return glossCache[word];
    const g = await translateText(word, 'de', settings.nativeLang || 'vi');
    glossCache[word] = g; return g;
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

  // ===== GĐ2: Flashcard SRS (lưu chrome.storage 'sd_srs_v1') =====
  const SRS_KEY = 'sd_srs_v1';
  function srsGet() { return new Promise((res) => { try { chrome.storage.local.get(SRS_KEY, (r) => res((r && r[SRS_KEY]) || {})); } catch (e) { res({}); } }); }
  function srsSet(d) { return new Promise((res) => { try { chrome.storage.local.set({ [SRS_KEY]: d }, res); } catch (e) { res(); } }); }
  const DAY = 86400000;
  async function renderFlash() {
    const pane = $('#flash');
    const r = await cmd('vocab'); const words = (r && r.savedWords) || [];
    if (!words.length) { pane.innerHTML = '<div class="empty">Chưa có từ. Click một từ trong câu → ⭐ Lưu để tạo thẻ.</div>'; return; }
    const srs = await srsGet(); const now = Date.now();
    const due = words.filter((w) => { const st = srs[w.word]; return !st || st.due <= now; });
    if (!due.length) { pane.innerHTML = '<div class="empty">🎉 Hết thẻ đến hạn! Quay lại sau. (' + words.length + ' từ đã lưu)</div>'; return; }
    const w = due[0];
    pane.innerHTML = '<div class="flashinfo">Đến hạn: ' + due.length + ' / Tổng: ' + words.length + '</div>' +
      '<div class="card"><div class="front">' + w.word + '</div><div class="back" id="cback" style="visibility:hidden">' +
      '… <i>' + (w.context || '') + '</i></div>' +
      '<div class="grades" id="cgrades" style="visibility:hidden">' +
      '<button class="g again" data-g="0">Lại</button><button class="g hard" data-g="1">Khó</button><button class="g good" data-g="2">Tốt</button></div>' +
      '<button class="btn" id="creveal" style="margin-top:12px">Lật thẻ / Nghe</button></div>';
    fetchGloss(w.word).then((g) => { const b = $('#cback'); if (b) b.innerHTML = (g || '') + ' <br><i>' + (w.context || '') + '</i>'; });
    $('#creveal').onclick = () => { $('#cback').style.visibility = 'visible'; $('#cgrades').style.visibility = 'visible'; speakText(w.word); };
    pane.querySelectorAll('.g').forEach((b) => b.onclick = async () => {
      const g = +b.dataset.g; const st = srs[w.word] || { interval: 0 };
      let iv = g === 0 ? 0 : g === 1 ? Math.max(1, (st.interval || 1)) : Math.max(1, (st.interval || 1) * 2 || 1);
      srs[w.word] = { interval: iv, due: now + (g === 0 ? 60000 : iv * DAY) };
      await srsSet(srs); renderFlash();
    });
  }


  // ===== Đọc mẫu theo ngôn ngữ học =====
  const BCP = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ru: 'ru-RU', nl: 'nl-NL' };
  function speakText(t) { cmd('speak', { text: t, rate: settings.rate, lang: BCP[settings.targetLang] || 'de-DE' }); }

  // ===== i18n (vi/en) =====
  const I18N = {
    vi: { tab_practice:'Luyện', tab_vocab:'Từ vựng', tab_flash:'Thẻ', tab_progress:'Tiến độ',
      nohost:'Mở một video YouTube hoặc Netflix rồi quay lại đây.',
      ob_title:'Bắt đầu nhanh', ob1:'Mở video tiếng Đức trên YouTube.', ob2:'Bấm "Phụ đề tự động" (hoặc nạp file SRT/VTT).', ob3:'Bấm "Bật mic", cho phép micro cho extension.', ob4:'Bấm một câu → nói lại → xem điểm.', ob_close:'Đã hiểu',
      src_auto:'Phụ đề tự động', src_live:'Live (bật CC)', src_file:'File SRT/VTT', src_mic:'Bật mic', src_diag:'Kiểm tra',
      status_init:'Mở video, lấy phụ đề để bắt đầu.',
      set_speed:'Tốc độ', set_rep:'Lặp', set_autonext:'Auto next', set_autorec:'Auto ghi âm', set_vsubs:'Phụ đề trên video', set_engine:'Engine', set_silero:'Silero VAD', set_offset:'Offset', set_target:'Học', set_native:'Dịch sang', set_uilang:'Ngôn ngữ', set_server:'Server', set_deepl:'DeepL key', set_orkey:'OpenRouter key',
      t_prev:'Câu trước', t_play:'Phát/Dừng', t_loop:'Lặp 1 câu', t_next:'Câu sau', t_shadow:'Luyện', t_listen:'Nghe mẫu', t_dict:'Chép chính tả', t_cloze:'Điền chỗ trống', t_blur:'Ẩn chữ (tự kiểm tra)', kbd_hint:'⌨ Space: nói · ◀ ▶: câu · ▲ ▼: tốc độ · R: nghe · L: lặp · B: ẩn chữ',
      fav_run:'▶️ Tự luyện dòng ⭐', stop:'⏹ Dừng', finalize:'✅ Tôi nói xong → chấm' },
    en: { tab_practice:'Practice', tab_vocab:'Words', tab_flash:'Cards', tab_progress:'Progress',
      nohost:'Open a YouTube or Netflix video, then come back here.',
      ob_title:'Quick start', ob1:'Open a German video on YouTube.', ob2:'Click "Auto subtitles" (or load an SRT/VTT file).', ob3:'Click "Enable mic" and allow microphone access for the extension.', ob4:'Click a line → speak it back → see your score.', ob_close:'Got it',
      src_auto:'Auto subtitles', src_live:'Live (turn on CC)', src_file:'SRT/VTT file', src_mic:'Enable mic', src_diag:'Self-test',
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
      (r.sentences === 0 ? '<div class="hintline">→ Bấm ⬇️ Phụ đề tự động / 🔴 Live / 📂 File.</div>' : '');
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

  // View switching
  function showView(name) {
    const vl = $('#view-list'), vp = $('#view-practice');
    if (vl) vl.hidden = name !== 'list';
    if (vp) vp.hidden = name !== 'practice';
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

  // License key validation button
  { const b = $('#btn-validate-license'); if (b) b.onclick = async () => {
    const inp = $('#license-key-input'); if (!inp) return;
    const key = inp.value.trim(); if (!key) return;
    const st = $('#license-status'); if (st) { st.textContent = 'Validating…'; st.className = 'license-status'; }
    b.disabled = true;
    const ok = await validateLicenseKey(key);
    if (ok) {
      settings.licenseKey = key; cmd('settings', settings);
      if (st) { st.textContent = '✓ License valid — translation enabled'; st.className = 'license-status ok'; }
    } else {
      if (st) { st.textContent = '✗ Invalid key. Contact seller to get a valid key.'; st.className = 'license-status err'; }
    }
    b.disabled = false;
  }; }

  // Vocab/flashcard sections in slide menu
  { const s = document.getElementById('section-vocab'); if (s) s.addEventListener('toggle', () => { if (s.open) loadVocab('vocab'); }); }
  { const s = document.getElementById('section-flash'); if (s) s.addEventListener('toggle', () => { if (s.open) renderFlash(); }); }
  { const s = document.getElementById('section-progress'); if (s) s.addEventListener('toggle', () => { if (s.open) loadVocab('progress'); }); }
  // Anki buttons in menu
  { const b = $('#anki-export'); if (b) b.onclick = exportAnki; }
  { const b = $('#anki-sync'); if (b) b.onclick = exportAnkiConnect; }

  // Initial view: list
  showView('list');

  // ===== Init =====
  if (window.ShadowMic) {
    window.ShadowMic.setLevelListener((level) => { const meter = $('#micLevel'); if (meter) meter.style.transform = 'scaleY(' + Math.max(.08, level).toFixed(2) + ')'; });
    window.ShadowMic.setProgressListener((status, pct) => onProgress({ status, pct }));
  }
  // Nut "Toi noi xong -> cham ngay": dung ghi am tuc thi nhung van cham diem
  {
    const fbtn = $('#finalizeBtn');
    if (fbtn) fbtn.onclick = () => { try { window.ShadowMic && window.ShadowMic.finalizeRecording(); } catch (e) {} fbtn.hidden = true; setStatus('🧮 Đang chấm…'); };
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
        if (recState === 'recording') { try { window.ShadowMic && window.ShadowMic.finalizeRecording(); } catch (_) {} const fb = $('#finalizeBtn'); if (fb) fb.hidden = true; }
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
      case 'KeyS': case 'Escape': e.preventDefault(); try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (_) {} cmd('stop'); break;
      default: break;
    }
  });
  maybeOnboard();
  connectPort();
  refresh();
})();
