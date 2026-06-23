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

  function setRecordScore(score) {
    const circ = 213.6; // 2π × r(34)
    const fill = $('#score-circle-fill');
    const num = $('#record-score-num');
    // SVG elements: className is read-only (SVGAnimatedString) → dùng setAttribute.
    if (score == null) {
      if (fill) { fill.style.strokeDashoffset = circ; fill.setAttribute('class', 'score-circle-fill'); }
      if (num) num.textContent = '–';
    } else {
      const pct = Math.max(0, Math.min(100, Math.round(score)));
      if (fill) {
        fill.style.strokeDashoffset = (circ * (1 - pct / 100)).toFixed(1);
        fill.setAttribute('class', 'score-circle-fill' + (pct >= 75 ? ' hi' : pct >= 50 ? ' mid' : ' lo'));
      }
      if (num) num.textContent = pct + '%';
    }
  }

  function onState(st) {
    const map = {
      playing: '▶️ Playing…',
      paused: '⏸ Paused',
      recording: '🎤 Listening…',
      transcribing: '⏳ Đang xử lý giọng nói…',
      scoring: '🧮 Scoring…',
      ad: '📺 Waiting for ad to end…',
    };
    recState = st.state || '';
    const fb = $('#finalizeBtn'); if (fb) fb.hidden = st.state !== 'recording';
    if (st.state && map[st.state]) setStatus(map[st.state] + (st.rep != null ? ' (rep ' + (st.rep + 1) + ')' : ''));
    // Record panel: update listening dot + status text
    const dot = $('#record-listening-dot');
    const stxt = $('#record-status-text');
    const isRec = st.state === 'recording';
    const isTranscribing = st.state === 'transcribing';
    const isScore = st.state === 'scoring';
    if (dot) dot.classList.toggle('active', isRec || isTranscribing);
    if (stxt) stxt.textContent = isRec ? 'Listening…' : isTranscribing ? 'Đang xử lý…' : isScore ? 'Đang chấm…' : 'Sẵn sàng';
    // Show record panel when recording starts
    if (isRec) {
      const el = $('#you-said-text'); if (el) el.textContent = '';
      showRecordPanel(true);
      startWaveform();
    } else if (!isTranscribing && !isScore) {
      stopWaveform();
    }
    // Nút "Chấm điểm" đổi thành "⏹ Dừng & chấm" khi đang ghi → cho dừng thủ công.
    const rescoreBtn = $('#btn-rescore');
    if (rescoreBtn) rescoreBtn.innerHTML = isRec ? '⏹ Dừng &amp; chấm' : '🎤 Chấm điểm';
    // Mic activity indicator: pulse speak button + mic dot when recording
    const speakBtn = $('#try-card-speak');
    if (speakBtn) speakBtn.classList.toggle('recording', isRec);
    const micBtn = $('#micButton');
    if (micBtn) micBtn.classList.toggle('recording', isRec);
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
    // Phụ đề kép: chưa có bản dịch -> tự dịch NGAY (Google/Microsoft/MyMemory miễn phí,
    // không cần đăng nhập). Đăng nhập chỉ giúp dùng DeepL/OpenRouter chất lượng hơn.
    if (!s.trans && s.text) {
      translateText(s.text, settings.targetLang || 'de', settings.nativeLang || 'vi').then((t) => {
        if (t) { s.trans = t; if ($('#nowDe').textContent === s.text) { $('#nowTr').textContent = t; if (trEl) trEl.textContent = t; } }
      }).catch(() => {});
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
    const txt = $('#try-card-text'); if (txt) txt.textContent = s ? '”' + s.text + '”' : '—';
    // Show next 2 sentences as clickable preview rows
    const previews = $('#try-card-previews');
    if (previews) {
      previews.innerHTML = '';
      for (let k = 1; k <= 2; k++) {
        const ns = sentences[current + k];
        if (!ns) break;
        const p = document.createElement('div');
        p.className = 'try-card-preview-row';
        p.textContent = ns.text;
        const idx = current + k;
        p.onclick = () => selectRow(idx);
        previews.appendChild(p);
      }
    }
  }

  function renderList() {
    const c = $('#sentence-list'); c.innerHTML = '';
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
      // 3 nut hover (an, hien khi chuot qua)
      const actions = document.createElement('div'); actions.className = 'row-actions';
      // Nut 🎤 — chon cau va bat dau ghi am
      const micBtn = document.createElement('button'); micBtn.className = 'row-action-btn'; micBtn.title = 'Luyện câu này'; micBtn.textContent = '🎤';
      micBtn.onclick = (e) => {
        e.stopPropagation();
        // 1) DỪNG video + tua về đầu câu NGAY (đồng bộ) -> video không chạy tiếp / lẫn tiếng
        //    trong lúc chờ cấp quyền mic (enableMic mất 1-3s lần đầu).
        current = i; cmd('select', { i, play: false });
        // 2) Chuyển sang khung luyện + render đúng câu i, mở panel Record, rồi ghi âm.
        openPractice(i); showRecordPanel(true); startShadow(i);
      };
      // Nut 🌐 — dich toan cau vao .tr
      const transBtn = document.createElement('button'); transBtn.className = 'row-action-btn'; transBtn.title = 'Dịch câu'; transBtn.textContent = '🌐';
      transBtn.onclick = async (e) => {
        e.stopPropagation();
        if (s.trans) { const trEl = body.querySelector('.tr'); if (trEl) { trEl.hidden = !trEl.hidden; } return; }
        transBtn.disabled = true;
        const t = await translateText(s.text, settings.targetLang || 'de', settings.nativeLang || 'vi');
        transBtn.disabled = false;
        if (t) { s.trans = t; const trEl = document.createElement('div'); trEl.className = 'tr'; trEl.textContent = t; body.appendChild(trEl); }
      };
      // Nut ≡+ — them vao yeu thich
      const menuBtn = document.createElement('button'); menuBtn.className = 'row-action-btn'; menuBtn.title = 'Thêm vào yêu thích'; menuBtn.textContent = '≡+';
      menuBtn.onclick = (e) => { e.stopPropagation(); cmd('favorite', { text: s.text }); menuBtn.textContent = '★'; setTimeout(() => { menuBtn.textContent = '≡+'; }, 1200); };
      actions.appendChild(micBtn); actions.appendChild(transBtn); actions.appendChild(menuBtn);
      row.appendChild(actions);
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

  // Gửi transcript + câu mục tiêu lên Worker → Groq Llama 3.3 70B chấm điểm (async, không block UI).
  async function claudeScoreAsync(target, transcript, aiBox) {
    try {
      const r = await Promise.race([
        fetch(WORKER_URL + '/score-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, transcript, targetLang: settings.targetLang || 'de' }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      if (!r.ok || !aiBox || !aiBox.isConnected) { if (aiBox) aiBox.hidden = true; return; }
      const ai = await r.json();
      if (ai.error || !aiBox.isConnected) { aiBox.hidden = true; return; }
      aiBox.innerHTML =
        '<div class="ai-score-head">🤖 AI đánh giá</div>' +
        '<div class="ai-score-bars">' +
          '<span>Phát âm <b>' + (ai.pronunciation ?? '—') + '</b></span>' +
          '<span>Lưu loát <b>' + (ai.fluency ?? '—') + '</b></span>' +
          '<span>Tổng <b>' + (ai.overall ?? '—') + '</b></span>' +
        '</div>' +
        (ai.feedback ? '<div class="ai-feedback">💡 ' + esc(ai.feedback) + '</div>' : '');
      aiBox.className = 'ai-score ai-score--done';
      aiBox.hidden = false; // ensure visible even if parent or prior code set hidden
    } catch { if (aiBox && aiBox.isConnected) aiBox.hidden = true; }
  }

  // ===== 🗣️ GỢI Ý PHÁT ÂM TIẾNG ĐỨC (cho từ phát âm sai) =====
  // Bảng tra cụm chữ → âm vị + cách đọc thân thiện tiếng Việt. Quét cụm DÀI trước.
  const DE_PHONEME_HINTS = [
    ['tsch', "đọc như 'ch' tiếng Anh (church)"],
    ['sch',  "/ʃ/ — đọc như 'sờ'"],
    ['chs',  "/ks/ — đọc như 'x'"],
    ['ei',   "đọc như 'ai'"],
    ['ie',   "đọc như 'i' kéo dài"],
    ['eu',   "đọc như 'oi'"],
    ['äu',   "đọc như 'oi'"],
    ['au',   "đọc như 'au'"],
    ['ch',   "/x/–/ç/ — 'kh' nhẹ ở cổ họng"],
    ['qu',   "/kv/ — đọc 'kv'"],
    ['ng',   "âm mũi 'ng'"],
    ['pf',   "bật 'p' rồi 'f' liền nhau"],
    ['ß',    "/s/ — 's' xì"],
    ['z',    "/ts/ — đọc 'ts'"],
    ['v',    "/f/ — đọc như 'ph'"],
    ['w',    "/v/ — đọc như 'v'"],
    ['ä',    "'e' mở rộng"],
    ['ö',    "tròn môi như 'ơ'"],
    ['ü',    "tròn môi như 'uy'"],
    ['r',    "âm 'r' rung ở cổ họng"],
  ];
  // Trả về tối đa 2 gợi ý nổi bật cho 1 từ (không trùng cụm).
  function germanHints(word) {
    const w = String(word || '').toLowerCase();
    const found = [];
    if (/^st/.test(w)) found.push({ cluster: 'st-', hint: "đầu từ đọc 'sht'" });
    if (/^sp/.test(w)) found.push({ cluster: 'sp-', hint: "đầu từ đọc 'shp'" });
    for (const [cluster, hint] of DE_PHONEME_HINTS) {
      if (found.length >= 2) break;
      if (w.includes(cluster) && !found.some((f) => f.cluster === cluster)) found.push({ cluster, hint });
    }
    return found.slice(0, 2);
  }
  // Cụm âm bị sai nhiều nhất trong các từ (cho gợi ý "Tập trung vào…").
  function topPhoneme(words) {
    const counts = {};
    (words || []).forEach((wd) => {
      if (wd.status === 'correct') return;
      germanHints(wd.text).forEach((h) => { counts[h.cluster] = (counts[h.cluster] || 0) + 1; });
    });
    let best = null, bestN = 0;
    for (const c in counts) if (counts[c] > bestN) { bestN = counts[c]; best = c; }
    return best;
  }
  // Tooltip cho 1 từ: nghe được gì + % giống + gợi ý phát âm (nếu sai).
  function wordTitle(w) {
    const parts = [w.heard ? 'Nghe: ' + w.heard : 'Không nghe'];
    if (w.sim != null) parts.push('Giống: ' + Math.round(w.sim * 100) + '%');
    if (w.status !== 'correct' && (settings.targetLang || 'de') === 'de') {
      const h = germanHints(w.text);
      if (h.length) parts.push('💡 ' + h.map((x) => x.hint).join(' · '));
    }
    return parts.join(' · ');
  }

  function triggerCelebration(tier) {
    const wrap = $('#record-score-circle-wrap') || document.querySelector('.record-score-circle-wrap');
    if (!wrap) return;
    // Remove any leftover confetti from prior run
    wrap.querySelectorAll('.confetti-piece').forEach((el) => el.remove());
    wrap.classList.remove('score-bounce', 'score-pulse');
    // Force reflow so animation restarts
    void wrap.offsetWidth;
    if (tier === 'excellent') {
      wrap.classList.add('score-bounce');
      const colors = ['#34a853', '#fbbc04', '#ea4335', '#1a73e8', '#9c27b0', '#ff9800', '#00bcd4'];
      for (let i = 0; i < 22; i++) {
        const p = document.createElement('span');
        p.className = 'confetti-piece';
        const angle = (i / 22) * 2 * Math.PI + (Math.random() - .5) * .6;
        const dist  = 35 + Math.random() * 45;
        p.style.cssText =
          '--cx:' + (Math.cos(angle) * dist).toFixed(0) + 'px;' +
          '--cy:' + (Math.sin(angle) * dist - 20).toFixed(0) + 'px;' +
          '--cr:' + Math.round(Math.random() * 540 - 270) + 'deg;' +
          'background:' + colors[i % colors.length] + ';' +
          'animation-delay:' + (i * 0.025).toFixed(3) + 's;' +
          'border-radius:' + (Math.random() > .5 ? '50%' : '2px') + ';';
        wrap.appendChild(p);
      }
      setTimeout(() => wrap.querySelectorAll('.confetti-piece').forEach((el) => el.remove()), 1600);
    } else if (tier === 'good') {
      wrap.classList.add('score-pulse');
    }
    setTimeout(() => wrap.classList.remove('score-bounce', 'score-pulse'), 800);
  }

  // Confetti nhỏ dùng chung — nổ từ tâm phần tử anchor (Chép/Điền khi đạt điểm cao).
  function miniConfetti(anchor, n) {
    if (!anchor) return;
    n = n || 18;
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    const colors = ['#34a853', '#fbbc04', '#ea4335', '#1a73e8', '#9c27b0', '#ff9800', '#00bcd4'];
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'confetti-piece';
      const angle = (i / n) * 2 * Math.PI + (Math.random() - .5) * .6;
      const dist  = 30 + Math.random() * 42;
      p.style.cssText =
        '--cx:' + (Math.cos(angle) * dist).toFixed(0) + 'px;' +
        '--cy:' + (Math.sin(angle) * dist - 16).toFixed(0) + 'px;' +
        '--cr:' + Math.round(Math.random() * 540 - 270) + 'deg;' +
        'background:' + colors[i % colors.length] + ';' +
        'animation-delay:' + (i * 0.022).toFixed(3) + 's;' +
        'border-radius:' + (Math.random() > .5 ? '50%' : '2px') + ';';
      anchor.appendChild(p);
    }
    setTimeout(() => anchor.querySelectorAll('.confetti-piece').forEach((el) => el.remove()), 1500);
  }
  // Hiện từng từ .fw trong container lần lượt với hiệu ứng "bật".
  function animateWords(container) {
    if (!container) return;
    container.querySelectorAll('.fw').forEach((el, i) => {
      el.style.animationDelay = (i * 0.045).toFixed(3) + 's';
      el.classList.add('fw-anim');
    });
  }

  function renderFeedback(f) {
    const box = $('#fb'); box.hidden = false;
    if (f.error) {
      let m = f.error, micFix = false, shortMsg = 'Chưa chấm được', hint = '';
      if (/server-unavailable/.test(f.error)) { m = 'Không kết nối được STT Server (' + f.error.replace('server-unavailable:', '') + '). Đổi Engine sang Web Speech trong Cài đặt.'; shortMsg = 'Lỗi server'; }
      else if (/whisper-unavailable/.test(f.error)) { m = 'Whisper chưa sẵn sàng — đang dùng Web Speech tạm. Thử lại sau giây lát.'; shortMsg = 'Đang tải model…'; }
      else if (/score-timeout/.test(f.error)) { m = '⏱️ Chấm quá lâu (mạng chậm hoặc model đang tải). Hãy thử lại — nói rõ, gần micro.'; shortMsg = 'Hết thời gian — thử lại'; hint = 'Nhấn 🎤 Chấm điểm để thử lại.'; }
      else if (/^mic|not-allowed|denied|audio-capture/.test(f.error)) { m = 'Cần quyền micro. Bấm 🔒/🎤 cạnh thanh địa chỉ của tab video → Microphone → Allow, rồi bấm Chấm điểm lại.'; micFix = true; shortMsg = 'Cần quyền micro'; hint = 'Cấp quyền micro rồi thử lại.'; }
      else if (/empty-transcript|silent/.test(f.error)) {
        const eng = f.engine || '';
        if (eng.includes('no-voice')) {
          m = '🔇 Micro không thu được tiếng nói. Kiểm tra: (1) Windows → Cài đặt → Âm thanh → <b>Đầu vào</b>: chọn đúng micro &amp; kéo âm lượng lên 100%; (2) nói sát micro hơn. Sau đó bấm 🎤 Chấm điểm lại.';
          shortMsg = 'Mic thu im lặng'; hint = 'Mic không thu được tiếng — kiểm tra thiết bị micro trong Windows.';
        } else {
          const groqHint = eng.includes('groq:') ? ' (' + eng.replace(/.*groq:/, 'Groq: ') + ')' : '';
          m = '🤔 Không nghe thấy gì' + groqHint + '. Nói to hơn, gần micro, rồi bấm 🎤 Chấm điểm.'; shortMsg = 'Không nghe thấy'; hint = 'Nói to & rõ hơn rồi bấm 🎤 Chấm điểm.';
        }
      }
      box.innerHTML = '<div class="err">⚠️ ' + m + (micFix ? ' <button class="mini sh" id="micfix">🎤 Cấp quyền micro</button>' : '') + '</div>';
      if (micFix) $('#micfix').onclick = () => openMicPermissionPage();
      // Cập nhật record panel để KHÔNG bị "đứng hình" — người dùng thấy ngay lý do.
      const stxt = $('#record-status-text'); if (stxt) stxt.textContent = shortMsg;
      const dot = $('#record-listening-dot'); if (dot) dot.classList.remove('active');
      const ys = $('#you-said-text'); if (ys) ys.textContent = hint || m.replace(/<[^>]+>/g, '');
      const tm = $('#score-tier-msg'); if (tm) tm.hidden = true;
      const pfe = $('#phoneme-focus'); if (pfe) pfe.hidden = true;
      setRecordScore(null);
      stopWaveform();
      return;
    }
    const sc = f.score;
    // Track XP and sentence status
    if (sc.overall != null) {
      recordPractice(sc.overall);
      const curSent = sentences[current];
      if (curSent) autoUpdateStatus(curSent.text, sc.overall);
      recordWeakWords(sc.words);
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
    const words = sc.words.map((w) => '<span class="fw ' + w.status + '" data-w="' + esc(w.text) + '" title="' + esc(wordTitle(w)) + '">' + esc(w.text) + '</span>').join(' ');
    box.innerHTML = '<div class="score-ring-wrap" style="position:relative">' +
      ring('Overall', sc.overall) + ring('Pronunc.', sc.pronunciation) +
      ring('Fluency', sc.fluency) + ring('Intonation', sc.intonation) + '</div>' +
      '<div class="words">' + words + '</div>' +
      '<div class="heard">You said: <i>' + esc(sc.transcript || '(nothing heard)') + '</i> · ' + esc(sc.engine || '') + '</div>' +
      (sc.lowConfidence ? '<div class="err" style="margin-top:6px">🤔 Nhận diện chưa chắc chắn — thử nói lại rõ hơn để chấm chính xác.</div>' : '') +
      '<div class="ai-score ai-score--loading">⏳ Đang chấm bằng AI…</div>';
    // Async: AI (Groq Llama) scores in background, updates UI when ready
    const aiBox = box.querySelector('.ai-score');
    if (aiBox && sc.transcript && f.sentence && f.sentence.text) {
      claudeScoreAsync(f.sentence.text, sc.transcript, aiBox);
    } else if (aiBox) {
      aiBox.hidden = true;
    }
    // Update record panel — YOU SAID: colored word spans. Bấm bất kỳ từ nào để xem cách phát âm.
    _lastScoreWords = sc.words || [];
    { const wd = $('#word-detail'); if (wd) wd.hidden = true; }
    const ys = $('#you-said-text');
    if (ys) {
      if (sc.words && sc.words.length) {
        ys.innerHTML = sc.words.map((w) =>
          '<span class="fw ' + w.status + ' fw-say" data-w="' + esc(w.text) +
          '" title="' + esc(wordTitle(w)) + '">' + esc(w.text) + '</span>'
        ).join('');
        ys.querySelectorAll('.fw-say').forEach((el) => {
          el.onclick = (e) => { e.stopPropagation(); showWordDetail(el.dataset.w); };
        });
      } else {
        ys.textContent = sc.transcript || '–';
      }
    }
    // 🎯 Gợi ý âm cần tập trung (từ cụm sai nhiều nhất) — chỉ tiếng Đức.
    const pfEl = $('#phoneme-focus');
    if (pfEl) {
      const top = (settings.targetLang || 'de') === 'de' ? topPhoneme(sc.words) : null;
      if (top) {
        const ent = DE_PHONEME_HINTS.find((x) => x[0] === top.replace(/-$/, ''));
        const hint = top === 'st-' ? "đầu từ đọc 'sht'" : top === 'sp-' ? "đầu từ đọc 'shp'" : (ent ? ent[1] : '');
        pfEl.innerHTML = "🎯 Tập trung vào âm <b>'" + esc(top.replace(/-$/, '')) + "'</b>" + (hint ? ' — ' + esc(hint) : '');
        pfEl.hidden = false;
      } else { pfEl.hidden = true; }
    }
    // Score tier message + celebration
    const tm = $('#score-tier-msg');
    if (tm) {
      const pct = sc.overall != null ? Math.round(sc.overall) : null;
      if (pct == null) {
        tm.hidden = true;
      } else if (pct >= 80) {
        tm.textContent = '🎉 Xuất sắc! Phát âm rất tốt!';
        tm.className = 'score-tier-msg tier-excellent';
        tm.hidden = false;
        setTimeout(() => triggerCelebration('excellent'), 350);
      } else if (pct >= 65) {
        tm.textContent = '👍 Tạm được! Tiếp tục cố gắng!';
        tm.className = 'score-tier-msg tier-good';
        tm.hidden = false;
        setTimeout(() => triggerCelebration('good'), 350);
      } else {
        tm.textContent = '💪 Cố lên! Thử lại nhé!';
        tm.className = 'score-tier-msg tier-try';
        tm.hidden = false;
      }
    }
    setRecordScore(sc.overall != null ? sc.overall : null);
    const stxt = $('#record-status-text'); if (stxt) stxt.textContent = 'Sẵn sàng';
    const dot = $('#record-listening-dot'); if (dot) dot.classList.remove('active');
    // Bật nút "Nghe lại" nếu có bản ghi để phát lại.
    { const rb = $('#btn-replay'); if (rb) rb.disabled = !(window.ShadowMic && window.ShadowMic.getLastBlob && window.ShadowMic.getLastBlob()); }
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
    if (typeof updatePauseToggle === 'function') updatePauseToggle();
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

  // ===== 📉 TỪ YẾU CÁ NHÂN (theo dõi từ phát âm sai qua nhiều phiên) =====
  const WEAK_KEY = 'se_weak_words_v1';
  let weakWords = {}; // { lemma: { word, miss, attempts, updatedAt } }

  async function loadWeakWords() {
    try { const r = await chrome.storage.local.get(WEAK_KEY); if (r[WEAK_KEY]) weakWords = r[WEAK_KEY]; } catch (_) {}
    renderWeakWords();
  }
  // Cập nhật danh sách từ yếu: từ sai/thiếu -> tăng miss; đọc đúng -> giảm dần.
  function recordWeakWords(scoreWords) {
    if ((settings.targetLang || 'de') !== 'de') return; // hiện chỉ hỗ trợ tiếng Đức
    let changed = false;
    (scoreWords || []).forEach((wd) => {
      const key = String(wd.text || '').toLowerCase();
      if (!key) return;
      const e = weakWords[key] || { word: wd.text, miss: 0, attempts: 0, updatedAt: 0 };
      e.attempts++;
      if (wd.status === 'wrong' || wd.status === 'missing') { e.miss++; changed = true; }
      else if (wd.status === 'correct' && e.miss > 0) { e.miss--; changed = true; } // đã đọc đúng -> bớt yếu
      e.word = wd.text; e.updatedAt = Date.now();
      weakWords[key] = e;
    });
    // Dọn từ đã thành thạo (miss <= 0) cho danh sách gọn.
    Object.keys(weakWords).forEach((k) => { if (weakWords[k].miss <= 0) delete weakWords[k]; });
    if (changed) { try { chrome.storage.local.set({ [WEAK_KEY]: weakWords }); } catch (_) {} renderWeakWords(); }
  }
  function renderWeakWords() {
    const box = $('#weak-words-list'); if (!box) return;
    const arr = Object.values(weakWords).filter((e) => e.miss > 0)
      .sort((a, b) => b.miss - a.miss || b.updatedAt - a.updatedAt).slice(0, 40);
    if (!arr.length) { box.innerHTML = '<div class="weak-empty">Chưa có từ yếu — luyện thêm để theo dõi! 💪</div>'; return; }
    box.innerHTML = arr.map((e) =>
      '<button class="weak-word-chip" data-w="' + esc(e.word) + '" title="Sai ' + e.miss + ' lần — bấm để nghe phát âm đúng">' +
      esc(e.word) + ' <span class="weak-word-count">×' + e.miss + '</span> 🔊</button>'
    ).join('');
    box.querySelectorAll('.weak-word-chip').forEach((b) => { b.onclick = () => speakText(b.dataset.w); });
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
    const box = $('#dictbox');
    box.className = 'dictbox as-panel';
    box.hidden = false;
    box.innerHTML =
      '<div class="dp-header">' +
        '<span class="dp-title">&#9997;&#65039; Ch&#233;p ch&#237;nh t&#7843;</span>' +
        '<button class="dp-close" id="dictclose">&#10005;</button>' +
      '</div>' +
      '<div class="dp-body">' +
        '<div class="dp-hint">Nghe v&#224; g&#245; l&#7841;i c&#226;u (kh&#244;ng nh&#236;n ph&#7909; &#273;&#7873;):</div>' +
        '<div class="recall-type-area"><textarea id="dictin" placeholder="G&#245; nh&#7919;ng g&#236; b&#7841;n nghe &#273;&#432;&#7907;c&#8230;"></textarea></div>' +
        '<div class="dp-result" id="dictres"></div>' +
      '</div>' +
      '<div class="dp-footer">' +
        '<button class="dp-btn" id="dictplay">&#128266; Nghe l&#7841;i</button>' +
        '<button class="dp-btn dp-btn--primary" id="dictcheck">Ki&#7875;m tra</button>' +
      '</div>';
    $('#dictin').focus();
    $('#dictplay').onclick = () => speakText(s.text);
    $('#dictclose').onclick = () => { box.hidden = true; };
    $('#dictcheck').onclick = () => {
      const ref = norm(s.text), hyp = norm($('#dictin').value);
      const hset = hyp.slice();
      const html = ref.map((w) => { const i = hset.indexOf(w); if (i >= 0) { hset.splice(i, 1); return '<span class="fw correct">' + w + '</span>'; } return '<span class="fw missing">' + w + '</span>'; }).join(' ');
      const correct = ref.filter((w) => hyp.includes(w)).length;
      const pct = Math.round(correct / (ref.length || 1) * 100);
      const cls = pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';
      const msg = pct >= 80 ? '🎉 Tuyệt vời!' : pct >= 50 ? '👍 Khá tốt!' : '💪 Thử lại nhé!';
      const resEl = $('#dictres');
      resEl.innerHTML = '<div class="dict-res-line"><span class="dict-res-pct ' + cls + '">' + pct + '%</span>' +
        '<span class="dict-res-msg ' + cls + '">' + msg + '</span></div>' +
        '<div class="res-words">' + html + '</div>';
      animateWords(resEl);
      if (pct >= 80) miniConfetti(resEl, 20);
    };
  }

  // ===== Ẩn chữ — kết hợp: Nghe → Ẩn → Tự nói hoặc Gõ → Hiện đáp án =====
  function startRecall() {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    speakText(s.text);
    const box = $('#dictbox');
    box.className = 'dictbox as-panel';
    box.hidden = false;
    box.innerHTML =
      '<div class="dp-header">' +
        '<span class="dp-title">🙈 Nghe → Nhớ → Luyện</span>' +
        '<button class="dp-close" id="recallClose">&#10005;</button>' +
      '</div>' +
      '<div class="dp-body">' +
        '<div class="recall-step">' +
          '<div class="recall-step-label"><span class="recall-step-num">1</span> Nghe câu</div>' +
          '<button class="dp-btn" id="recallPlay">&#128266; Nghe l&#7841;i</button>' +
        '</div>' +
        '<div class="recall-step">' +
          '<div class="recall-step-label"><span class="recall-step-num">2</span> C&#226;u g&#7889;c (b&#7845;m &#273;&#7875; hi&#7879;n)</div>' +
          '<div class="recall-hidden res" id="recallText" style="cursor:pointer;font-size:14px;line-height:1.6;padding:8px 10px;border-radius:10px;background:#f8f9fa">' + esc(s.text) + '</div>' +
        '</div>' +
        '<div class="recall-step">' +
          '<div class="recall-step-label"><span class="recall-step-num">3</span> Luy&#7879;n — ch&#7885;n c&#225;ch</div>' +
          '<div class="recall-actions" id="recallActions"></div>' +
        '</div>' +
      '</div>' +
      '<div class="dp-footer">' +
        '<button class="dp-btn" id="recallReveal">&#128065; Hi&#7879;n &#273;&#225;p &#225;n</button>' +
      '</div>';

    const txt = $('#recallText');
    const revealAnim = () => {
      if (!txt) return;
      txt.classList.remove('recall-reveal-anim');
      void txt.offsetWidth;
      txt.classList.add('recall-reveal-anim');
    };

    $('#recallPlay').onclick = () => speakText(s.text);
    $('#recallClose').onclick = () => { box.hidden = true; };
    if (txt) txt.onclick = () => { txt.classList.remove('recall-hidden'); revealAnim(); };

    $('#recallReveal').onclick = () => {
      if (txt) { txt.classList.remove('recall-hidden'); revealAnim(); }
    };

    // 2 chế độ luyện: "Nói & chấm" (mở record panel) hoặc "Gõ toàn câu" (textarea ngay đây).
    const actEl = $('#recallActions');

    function renderActionsDefault() {
      if (!actEl) return;
      actEl.innerHTML =
        '<button class="dp-btn dp-btn--primary" id="recallSpeak">&#127908; N&#243;i &amp; ch&#7845;m</button>' +
        '<button class="dp-btn" id="recallType">&#9997;&#65039; G&#245; to&#224;n c&#226;u</button>';
      $('#recallSpeak').onclick = () => { box.hidden = true; showRecordPanel(true); scoreNow(); };
      $('#recallType').onclick  = renderTypeMode;
    }

    function renderTypeMode() {
      if (!actEl) return;
      actEl.innerHTML =
        '<div class="recall-type-area">' +
          '<textarea id="recallTypeIn" placeholder="G&#245; l&#7841;i to&#224;n b&#7897; c&#226;u b&#7841;n v&#7915;a nghe&#8230;"></textarea>' +
          '<div style="display:flex;gap:8px">' +
            '<button class="dp-btn dp-btn--primary" id="recallTypeCheck">Ki&#7875;m tra</button>' +
            '<button class="dp-btn" id="recallRetry">&#8635; L&#224;m l&#7841;i</button>' +
          '</div>' +
          '<div class="recall-type-res" id="recallTypeRes"></div>' +
        '</div>';
      const inp = $('#recallTypeIn'); if (inp) inp.focus();
      $('#recallRetry').onclick = renderActionsDefault;
      $('#recallTypeCheck').onclick = () => {
        const ref = norm(s.text), hyp = norm((inp && inp.value) || '');
        const hset = hyp.slice();
        const html = ref.map((w) => {
          const i = hset.indexOf(w); if (i >= 0) { hset.splice(i, 1); return '<span class="fw correct">' + esc(w) + '</span>'; }
          return '<span class="fw missing">' + esc(w) + '</span>';
        }).join(' ');
        const correct = ref.filter((w) => hyp.includes(w)).length;
        const pct = Math.round(correct / (ref.length || 1) * 100);
        const cls = pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';
        const msg = pct >= 80 ? '&#127881; Tuy&#7879;t v&#7901;i!' : pct >= 50 ? '&#128077; Kh&#225; t&#7889;t!' : '&#128170; Th&#7917; l&#7841;i nh&#233;!';
        const resEl = $('#recallTypeRes');
        resEl.innerHTML =
          '<div class="dict-res-line"><span class="dict-res-pct ' + cls + '">' + pct + '%</span>' +
          '<span class="dict-res-msg ' + cls + '">' + msg + '</span></div>' +
          '<div class="res-words">' + html + '</div>';
        animateWords(resEl);
        if (pct >= 80) { if (txt) { txt.classList.remove('recall-hidden'); revealAnim(); } miniConfetti(resEl, 16); }
      };
    }

    renderActionsDefault();
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
  // Gửi yêu cầu tới page-mic.js trên tab video, chờ phản hồi.
  async function pageMicRequest(action, opts) {
    const t = await activeTab(); if (!t) return null;
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(t.id, { sd: 'page-mic', action, opts: opts || {} },
          (r) => { resolve(chrome.runtime.lastError ? null : r); });
      } catch (e) { resolve(null); }
    });
  }

  { const b = $('#btn-selftest'); if (b) b.onclick = () => runDiag('#selftest-box'); }

  async function runDiag(boxSel) {
    const box = $(boxSel || '#diagbox'); box.hidden = false;
    box.innerHTML = '⏳ Đang kiểm tra kết nối…';
    const r = await cmd('diag');
    if (!r || !r.ok) { box.innerHTML = '<b class="bad">✗ Không kết nối được content script.</b> Mở/tải lại tab YouTube hoặc Netflix rồi thử lại.'; return; }
    try { const p = await chrome.runtime.sendMessage({ sd: 'mic-service', action: 'permission' }); if (p && p.ok) r.mic = p.state; } catch (e) {}
    const row = (ok, label, val) => '<div class="drow2"><span class="' + (ok ? 'gook' : 'gobad') + '">' + (ok ? '✓' : '✗') + '</span> ' + label + (val != null ? ': <b>' + esc(String(val)) + '</b>' : '') + '</div>';

    let html =
      row(true, 'Trang', r.host) +
      row(r.video, 'Tìm thấy &lt;video&gt;') +
      row(r.sentences > 0, 'Phụ đề đã nạp', r.sentences + ' câu') +
      row(r.engine, 'Engine sẵn sàng') +
      row(r.vsubs, 'Overlay phụ đề video');

    // Self-test sâu: ghi âm thật + Groq (mất ~4-5s, cần nói vài tiếng).
    html += '<div class="hintline">🎤 Đang ghi âm 4 giây — <b>HÃY NÓI TO “một hai ba bốn năm” NGAY BÂY GIỜ</b>…</div>';
    box.innerHTML = html;
    const st = await pageMicRequest('selftest', { record: true, recMs: 4000 });
    const report = st && st.ok && st.report ? st.report : null;

    // KẾT LUẬN nổi bật lên đầu: mic có thu được tiếng + Groq nghe được gì.
    let verdict = '';
    if (report && report.steps) {
      const micStep = report.steps.find((s) => /Mức âm mic/.test(s.name));
      const groqStep = report.steps.find((s) => /Groq chấm/.test(s.name));
      if (micStep && !micStep.ok) verdict = '<div class="err">🔴 <b>MICRO KHÔNG THU ĐƯỢC TIẾNG.</b> ' + esc(micStep.detail) + '<br>→ Windows: Settings → System → Sound → <b>Input</b> → chọn đúng mic + kéo Volume lên 100%. Thử nói sát mic.</div>';
      else if (micStep && groqStep && groqStep.ok) verdict = '<div class="ok-banner" style="background:#e6f4ea;color:#137333;padding:8px;border-radius:8px;margin-bottom:6px">🟢 <b>MỌI THỨ HOẠT ĐỘNG!</b> Groq ' + esc(groqStep.detail) + '</div>';
      else if (micStep && micStep.ok) verdict = '<div class="hintline">🟡 Mic thu tốt nhưng Groq chưa ra chữ — xem dòng Groq bên dưới.</div>';
    }
    html = verdict + html;

    if (report && report.steps) {
      report.steps.forEach((s) => { html += row(s.ok, s.name, s.detail); });
    } else {
      html += row(false, 'Self-test ghi âm', 'không chạy được — TẢI LẠI extension (chrome://extensions → Reload) rồi thử lại');
    }

    // Khối văn bản để COPY gửi support.
    const lines = ['=== ShadowEcho self-test ===',
      'host: ' + (r.host || ''),
      'video: ' + r.video + ' · subs: ' + r.sentences + ' · engine: ' + r.engine,
      'mic(extension): ' + r.mic];
    if (report && report.steps) {
      lines.push('ua: ' + (report.ua || ''));
      report.steps.forEach((s) => lines.push((s.ok ? '[OK] ' : '[FAIL] ') + s.name + ': ' + s.detail));
    }
    const reportText = lines.join('\n');
    html += '<div class="hintline">📋 Sao chép báo cáo dưới đây rồi gửi cho tôi:</div>';
    html += '<textarea id="diag-report" readonly style="width:100%;height:110px;font:11px monospace;margin-top:4px;border:1px solid #dadce0;border-radius:6px;padding:6px;background:#f8f9fa;color:#202124">' + esc(reportText) + '</textarea>';
    html += '<button class="mini sh" id="diag-copy" style="margin-top:6px">📋 Copy báo cáo</button>';
    // Bọc trong khung cuộn được để KHÔNG bị cắt mất dòng kết quả ghi âm/Groq.
    box.innerHTML = '<div style="max-height:340px;overflow-y:auto">' + html + '</div>';
    const cp = $('#diag-copy');
    if (cp) cp.onclick = () => { try { const ta = $('#diag-report'); ta.select(); document.execCommand('copy'); cp.textContent = '✅ Đã copy'; setTimeout(() => { cp.textContent = '📋 Copy báo cáo'; }, 1500); } catch (e) {} };
  }

  // ===== Fill-in-the-blank (cloze) =====
  function startCloze() {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    const box = $('#dictbox');
    box.className = 'dictbox as-panel';
    box.hidden = false;
    // Hiện trước câu + chọn độ khó
    box.innerHTML =
      '<div class="dp-header">' +
        '<span class="dp-title">&#129513; &#272;i&#7873;n t&#7915; c&#242;n thi&#7871;u</span>' +
        '<button class="dp-close" id="czclosesel">&#10005;</button>' +
      '</div>' +
      '<div class="dp-body">' +
        '<div class="dp-sentence-preview">' + esc(s.text) + '</div>' +
        '<div class="dp-diff-label">CH&#7884;N &#272;&#7896; KH&#211;:</div>' +
        '<div class="dp-diff-btns">' +
          '<button class="dp-diff-btn" data-diff="easy">&#129001;<br>D&#7877;<small>~25% t&#7915;</small></button>' +
          '<button class="dp-diff-btn" data-diff="medium">&#129000;<br>V&#7915;a<small>~50% t&#7915;</small></button>' +
          '<button class="dp-diff-btn" data-diff="hard">&#128997;<br>Kh&#243;<small>~75% t&#7915;</small></button>' +
        '</div>' +
      '</div>';
    $('#czclosesel').onclick = () => { box.hidden = true; };
    box.querySelectorAll('.dp-diff-btn').forEach((btn) => {
      btn.onclick = () => runCloze(s, btn.dataset.diff, box);
    });
  }

  function runCloze(s, difficulty, box) {
    const toks = s.text.split(/(\s+)/);
    // Tỷ lệ và độ dài từ tối thiểu theo cấp độ
    const pctMap    = { easy: 0.27, medium: 0.50, hard: 0.75 };
    const minLenMap = { easy: 6,    medium: 4,     hard: 3    };
    const pct    = pctMap[difficulty]    || 0.50;
    const minLen = minLenMap[difficulty] || 4;
    const idxBlank = [];
    toks.forEach((w, i) => {
      const clean = w.replace(/[^A-Za-zäöüÄÖÜß]/g, '');
      if (clean.length >= minLen && Math.random() < pct) idxBlank.push(i);
    });
    // Đảm bảo ít nhất 1 ô trống
    if (!idxBlank.length) {
      const fallback = toks.findIndex((w) => w.trim().replace(/[^A-Za-zäöüÄÖÜß]/g, '').length >= 3);
      if (fallback >= 0) idxBlank.push(fallback);
    }
    const diffLabel = { easy: '&#129001; D&#7877;', medium: '&#129000; V&#7915;a', hard: '&#128997; Kh&#243;' }[difficulty] || '';
    let czLine = '';
    toks.forEach((w, i) => {
      if (idxBlank.includes(i)) {
        czLine += '<input class="cz" data-ans="' + esc(w.trim()) + '" size="' + Math.max(3, w.length) + '" placeholder="?">';
      } else {
        czLine += esc(w);
      }
    });
    box.innerHTML =
      '<div class="dp-header">' +
        '<span class="dp-title">&#129513; ' + diffLabel + '</span>' +
        '<button class="dp-close" id="czclose">&#10005;</button>' +
      '</div>' +
      '<div class="dp-body">' +
        '<div class="dp-hint">Nghe &#273;&#7875; g&#7907;i &#253; &#8226; &#272;i&#7873;n v&#224;o &#244; tr&#7889;ng:</div>' +
        '<div class="dp-cz-line">' + czLine + '</div>' +
        '<div class="dp-result" id="czres"></div>' +
      '</div>' +
      '<div class="dp-footer">' +
        '<button class="dp-btn" id="czplay">&#128266; Nghe</button>' +
        '<button class="dp-btn dp-btn--primary" id="czcheck">Ki&#7875;m tra</button>' +
      '</div>';
    speakText(s.text);
    const firstInp = box.querySelector('.cz'); if (firstInp) firstInp.focus();
    $('#czclose').onclick = () => { box.hidden = true; };
    $('#czplay').onclick  = () => speakText(s.text);
    // Enter key trên ô cuối → kiểm tra
    box.querySelectorAll('.cz').forEach((inp, idx, all) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (idx < all.length - 1) all[idx + 1].focus(); else $('#czcheck') && $('#czcheck').click(); } });
    });
    $('#czcheck').onclick = () => {
      let ok = 0, tot = 0;
      box.querySelectorAll('.cz').forEach((inp) => {
        tot++;
        const ans = (inp.dataset.ans || '').toLowerCase().replace(/[^a-zäöüß]/g, '');
        const got = (inp.value || '').toLowerCase().replace(/[^a-zäöüß]/g, '');
        const good = ans === got; if (good) ok++;
        inp.classList.remove('cz-ok', 'cz-bad');
        void inp.offsetWidth;
        inp.classList.add(good ? 'cz-ok' : 'cz-bad');
        if (!good) inp.value = inp.dataset.ans;
      });
      const pct2  = Math.round(ok / (tot || 1) * 100);
      const cls   = pct2 >= 80 ? 'hi' : pct2 >= 50 ? 'mid' : 'lo';
      const msg   = (ok === tot && tot > 0) ? '&#127881; Ho&#224;n h&#7843;o!' : pct2 >= 50 ? '&#128077; G&#7847;n &#273;&#250;ng!' : '&#128170; Th&#7917; l&#7841;i nh&#233;!';
      const resEl = $('#czres');
      resEl.innerHTML = '<div class="dict-res-line"><span class="dict-res-pct ' + cls + '">' + ok + '/' + tot + '</span>' +
        '<span class="dict-res-msg ' + cls + '">' + msg + '</span></div>';
      if (ok === tot && tot > 0) miniConfetti(resEl, 20);
    };
  }

  // ===== ShadowEcho-style UI wiring =====

  // View switching (auth | list | practice | onboard) — fade-in active view
  function showView(name) {
    const va = $('#view-auth'), vl = $('#view-list'), vp = $('#view-practice'), vo = $('#view-onboard');
    if (va) va.hidden = name !== 'auth';
    if (vl) vl.hidden = name !== 'list';
    if (vp) { vp.hidden = name !== 'practice'; if (name === 'practice') vp.scrollTop = 0; }
    if (vo) vo.hidden = name !== 'onboard';
    // Fade-in the visible view
    const active = { auth: va, list: vl, practice: vp, onboard: vo }[name];
    if (active) { active.classList.remove('view--in'); void active.offsetWidth; active.classList.add('view--in'); }
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
    if (i >= 0 && i < sentences.length) {
      // QUAN TRỌNG: render câu ĐÚNG i vào khung lớn ngay — nếu không, #current-text giữ
      // câu cũ (lỗi "panel hiện sai câu" khi bấm 🎤 trong danh sách).
      current = i;
      renderNow({ idx: i, total: sentences.length, sentence: sentences[i] });
    }
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
  { const b = $('#btn-shadow'); if (b) b.onclick = () => { showRecordPanel(true); scoreNow(); }; }
  { const b = $('#btn-prev'); if (b) b.onclick = () => cmd('prev'); }
  { const b = $('#btn-next'); if (b) b.onclick = () => { cmd('next'); if (sentences[current + 1]) openPractice(current + 1); }; }
  { const b = $('#btn-dictation'); if (b) b.onclick = () => startDictation(); }
  { const b = $('#btn-cloze'); if (b) b.onclick = () => startCloze(); }
  { const b = $('#btn-hint'); if (b) b.onclick = () => { const s = sentences[current]; if (s && s.trans) setStatus(s.trans, 'ok'); else if (s) translateText(s.text, settings.targetLang, settings.nativeLang).then((t) => { if (t) { s.trans = t; setStatus(t, 'ok'); } }); }; }
  { const b = $('#btn-shadow-fav'); if (b) b.onclick = async () => { if (!settings.autoRecord || await enableMic({ silent: true })) cmd('shadowFav', { target: settings.targetLang, native: settings.nativeLang }); }; }
  { const b = $('#btn-blur'); if (b) b.onclick = startRecall; }
  { const b = $('#btn-listen'); if (b) b.onclick = () => { const s = sentences[current]; if (s) speakText(s.text); }; }
  // 🔁 Nghe lại bản ghi của chính mình (blob cuối cùng từ mic-service).
  {
    const b = $('#btn-replay');
    if (b) b.onclick = () => {
      try {
        const blob = window.ShadowMic && window.ShadowMic.getLastBlob && window.ShadowMic.getLastBlob();
        if (!blob) { setStatus('Chưa có bản ghi để nghe lại — hãy nói & chấm trước.', 'warn'); return; }
        if (replayAudio) { try { replayAudio.pause(); URL.revokeObjectURL(replayAudio.src); } catch (_) {} }
        replayAudio = new Audio(URL.createObjectURL(blob));
        b.classList.add('playing');
        replayAudio.onended = replayAudio.onerror = () => { b.classList.remove('playing'); try { URL.revokeObjectURL(replayAudio.src); } catch (_) {} };
        replayAudio.play().catch(() => { b.classList.remove('playing'); });
      } catch (_) {}
    };
  }
  { const b = $('#btn-load-auto'); if (b) b.onclick = () => cmd('loadAuto', { target: settings.targetLang, native: settings.nativeLang }); }
  { const b = $('#btn-load-live'); if (b) b.onclick = async () => { const r = await cmd('live'); if (r) b.classList.toggle('on', !!r.running); }; }

  // The "Luyện câu này" (ShadowEcho-style): Nghe mẫu / Nói & chấm / Câu sau
  { const b = $('#try-card-listen'); if (b) b.onclick = () => { const s = sentences[current]; if (s) { cmd('select', { i: current }); speakText(s.text); } }; }
  { const b = $('#try-card-speak'); if (b) b.onclick = () => { if (!sentences.length) return; openPractice(current); showRecordPanel(true); scoreNow(); }; }
  { const b = $('#try-card-next'); if (b) b.onclick = () => { if (current + 1 < sentences.length) selectRow(current + 1); }; }
  // Nut "Tu dung" tren the luyen tap — bat/tat tu dung cuoi moi cau (segPause).
  function updatePauseToggle() {
    const b = $('#try-pause-toggle'); if (!b) return;
    const on = settings.segPause !== false;
    b.classList.toggle('on', on);
    b.textContent = on ? '⏸ Tự dừng: Bật' : '▶ Tự dừng: Tắt';
  }
  { const b = $('#try-pause-toggle'); if (b) b.onclick = () => {
      settings.segPause = !(settings.segPause !== false);
      if ($('#segpause')) $('#segpause').checked = settings.segPause;
      cmd('settings', settings);
      updatePauseToggle();
      setStatus(settings.segPause ? '⏸ Tự dừng cuối mỗi câu: BẬT' : '▶ Tự dừng cuối mỗi câu: TẮT', 'ok');
    }; }

  // Record panel
  function showRecordPanel(show) { const p = $('#record-panel'); if (p) { if (show) syncToolbarHeight(); p.hidden = !show; } }
  { const b = $('#btn-record-close'); if (b) b.onclick = () => { try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (_) {} showRecordPanel(false); }; }

  // ───────────────────────────────────────────────────────────────────────
  // CHẤM ĐIỂM (kiến trúc mới): ghi âm + Groq + chấm điểm HOÀN TOÀN trong Side
  // Panel (DOM extension ổn định, đã có quyền mic). Content script chỉ tạm dừng
  // video. Bỏ hẳn content-script recording / Web Speech / Whisper offline.
  // ───────────────────────────────────────────────────────────────────────
  let panelRecording = false;
  let replayAudio = null; // Audio đang phát lại bản ghi của người dùng
  let _lastScoreWords = null; // Từ cuối cùng được chấm điểm — dùng cho word detail popup
  function setPanelRecUI(on) {
    const dot = $('#record-listening-dot'); if (dot) dot.classList.toggle('active', on);
    const st = $('#record-status-text'); if (st) st.textContent = on ? 'Listening…' : 'Đang chấm…';
    const b = $('#btn-rescore'); if (b) b.innerHTML = on ? '⏹ Dừng &amp; chấm' : '🎤 Chấm điểm';
  }
  async function scoreNow() {
    if (!sentences.length) { setStatus('Chưa có câu để chấm.', 'warn'); return; }
    // Đang ghi → bấm lần nữa = "Dừng & chấm": chốt ngay phần đã nói.
    if (panelRecording) { try { window.ShadowMic && window.ShadowMic.finalizeRecording(); } catch (_) {} return; }
    if (!window.ShadowMic || !window.ShadowMic.recordAndTranscribe) { setStatus('Mic service chưa sẵn sàng — tải lại extension.', 'warn'); return; }
    const idx = Math.max(0, Math.min(current, sentences.length - 1));
    const s = sentences[idx]; if (!s) return;
    current = idx;
    showRecordPanel(true);
    setRecordScore(null);
    { const el = $('#you-said-text'); if (el) el.textContent = ''; }
    { const tm = $('#score-tier-msg'); if (tm) tm.hidden = true; }
    { const pfe = $('#phoneme-focus'); if (pfe) pfe.hidden = true; }
    { const rb = $('#btn-replay'); if (rb) rb.disabled = true; }
    const fb = $('#fb'); if (fb) fb.hidden = true;
    // Tạm dừng video trên trang để tiếng video không lẫn vào mic (echo).
    cmd('holdPause', { ms: 9000 });
    panelRecording = true; setPanelRecUI(true); startWaveform();
    let res;
    try {
      res = await window.ShadowMic.recordAndTranscribe({ maxMs: 7000, lang2: settings.targetLang || 'de', useSileroVad: !!settings.useSileroVad });
    } catch (e) { res = { error: 'rec:' + ((e && e.message) || e) }; }
    panelRecording = false; setPanelRecUI(false); stopWaveform();
    cmd('releasePause');
    if (!res || res.error) {
      if (res && res.error === 'aborted') { const st = $('#record-status-text'); if (st) st.textContent = 'Sẵn sàng'; return; }
      if (res && res.error === 'WHISPER_LOADING') {
        const st = $('#record-status-text'); if (st) st.textContent = 'Sẵn sàng';
        setStatus('⏳ Model phát âm offline đang tải (~2 phút). Hãy thử lại sau.', 'warn');
        return;
      }
      renderFeedback({ error: (res && res.error) || 'unknown' });
      return;
    }
    if (!res.transcript) { renderFeedback({ error: 'empty-transcript', engine: res.engine }); return; }
    // Chấm điểm NGAY trong Side Panel (phonetic.js đã nạp).
    let score = null;
    try {
      if (window.SD && window.SD.phonetic) {
        score = window.SD.phonetic.analyze(s.text, res.transcript, { pitch: res.pitch || [], spokenMs: res.spokenMs, refMs: (s.endMs - s.startMs) });
      }
    } catch (e) {}
    if (!score) { renderFeedback({ error: 'Thiếu bộ chấm điểm (phonetic.js) — tải lại extension.' }); return; }
    score.engine = res.engine;
    renderFeedback({ score, sentence: s });
  }
  { const b = $('#btn-rescore'); if (b) b.onclick = () => scoreNow(); }

  // Word detail popup — bấm từ trong YOU SAID để xem phát âm
  function showWordDetail(word) {
    const popup = $('#word-detail');
    if (!popup) return;
    const wData = (_lastScoreWords || []).find((w) => w.text === word);
    const wEl = $('#word-detail-w');
    if (wEl) wEl.textContent = word;
    const stEl = $('#word-detail-status');
    if (stEl) {
      const statusMap = { correct: '✓ Đúng', near: '~ Gần đúng', wrong: '✗ Sai', missing: '— Thiếu' };
      const st = wData ? wData.status : '';
      stEl.textContent = wData ? (statusMap[st] || '') : '';
      stEl.className = 'word-detail-status ' + st;
    }
    const hintsEl = $('#word-detail-hints');
    if (hintsEl) {
      const isDe = (settings.targetLang || 'de') === 'de';
      const hints = isDe ? germanHints(word) : [];
      if (hints.length) {
        hintsEl.innerHTML = hints.map((h) =>
          '<span class="wdh-row"><b>' + esc(h.cluster) + '</b> → ' + esc(h.hint) + '</span>'
        ).join('');
        hintsEl.hidden = false;
      } else {
        hintsEl.innerHTML = '';
        hintsEl.hidden = true;
      }
    }
    const simEl = $('#word-detail-sim');
    if (simEl) {
      if (wData && wData.sim != null) {
        const heard = wData.heard ? ' · Nghe: "' + wData.heard + '"' : '';
        simEl.textContent = 'Giống ' + Math.round(wData.sim * 100) + '%' + heard;
        simEl.hidden = false;
      } else {
        simEl.hidden = true;
      }
    }
    const speakEl = $('#word-detail-speak');
    if (speakEl) speakEl.onclick = () => speakText(word);
    popup.hidden = false;
  }
  { const b = $('#word-detail-close'); if (b) b.onclick = () => { const p = $('#word-detail'); if (p) p.hidden = true; }; }

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
      const st  = window.ShadowMic.whisperStatus ? window.ShadowMic.whisperStatus(settings.whisperModel) : null;
      const hw  = (st && st.hw) || window.ShadowMic.detectHardware();
      const sel = window.ShadowMic.pickWhisperModel(settings.whisperModel);
      // describeChoice: mô tả rõ lý do chọn (% RAM, cores) — dùng nếu có
      const desc = (window.WhisperSelect && window.WhisperSelect.describeChoice)
        ? window.WhisperSelect.describeChoice(hw, settings.whisperModel === 'auto' ? 'auto' : settings.whisperModel)
        : (sel.short.toUpperCase() + ' · ' + sel.label);
      const memEff = (window.WhisperSelect && window.WhisperSelect.effectiveMem) ? window.WhisperSelect.effectiveMem(hw) : hw.mem;
      const memTxt = memEff >= 8 ? memEff + 'GB' : hw.mem + 'GB';
      if (settings.engine !== 'whisper') {
        el.textContent = '🖥️ ' + memTxt + ' RAM · ' + hw.cores + ' nhân CPU';
      } else if (!avail) {
        el.textContent = '⚠️ Thiếu thư viện Whisper (vendor/) — đang dùng Web Speech tạm.';
      } else if (st && st.upgrading && st.active) {
        el.textContent = '🖥️ Đang chạy ' + st.active.toUpperCase() + ', nâng lên ' + sel.short.toUpperCase() + ' ở nền… · ' + memTxt;
      } else {
        el.textContent = '🖥️ ' + desc;
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
    // Luôn tải sẵn Whisper ở nền khi mở panel (chiến lược: Groq trước → Whisper sau khi tải xong).
    // Nếu người dùng chọn engine 'whisper' → cũng refresh UI khi model sẵn sàng.
    if (window.ShadowMic.warmupWhisper) {
      const wModel = settings.engine === 'whisper' ? (settings.whisperModel || 'auto') : 'auto';
      window.ShadowMic.warmupWhisper(wModel).catch(() => {});
      if (settings.engine === 'whisper') {
        let n = 0; const hwTimer = setInterval(() => { updateHwInfo(); if (++n >= 20) clearInterval(hwTimer); }, 1500);
      }
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
      case 'Space': // ghi âm câu hiện tại / dừng & chấm nếu đang ghi
        e.preventDefault();
        scoreNow(); // tự xử lý: đang ghi → finalize; chưa ghi → bắt đầu ghi & chấm
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
  // --- Đồng bộ chiều cao thanh công cụ dưới → biến CSS --toolbar-h ---
  // Thanh công cụ 2 hàng có nhãn cao hơn giá trị mặc định trong CSS. Nếu lệch,
  // record panel (ngồi ở bottom:var(--toolbar-h)) bị thanh công cụ che mất 2 nút
  // Listen/Chấm điểm. Đo CHÍNH XÁC chiều cao thật rồi áp vào biến → luôn vừa khít,
  // bất kể font/dark mode/màn hình nhỏ.
  function syncToolbarHeight() {
    const tb = $('#bottom-toolbar'); if (!tb || tb.hidden) return;
    const h = Math.ceil(tb.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--toolbar-h', h + 'px');
  }
  syncToolbarHeight();
  window.addEventListener('resize', syncToolbarHeight);
  window.addEventListener('load', syncToolbarHeight);
  try {
    const tb = $('#bottom-toolbar');
    if (tb && window.ResizeObserver) { const ro = new ResizeObserver(syncToolbarHeight); ro.observe(tb); }
  } catch (_) {}

  // Load persistent data
  loadStreak();
  loadSentStatus();
  loadWeakWords();
  loadDarkMode();
  initOnboardingUI();
  initUpgradeUI();

  maybeOnboard();
  connectPort();
  // refresh() is called by auth state handler after login; skip here to avoid duplicate
  if (typeof ShadowAuth === 'undefined') refresh();
})();
