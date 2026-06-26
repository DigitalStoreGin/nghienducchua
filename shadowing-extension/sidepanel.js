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
  let settings = { rate: 1, repeat: 3, autoNext: true, autoRecord: true, segPause: true, engine: 'webspeech', whisperModel: 'auto', useSileroVad: false, offsetMs: 0, nativeLang: 'vi', targetLang: 'de', uiLang: 'vi', videoSubs: true, extEnabled: true, hideText: false, serverUrl: 'http://localhost:8000' };
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
      case 'current':
        // Bo qua su kien lac trong cua so chon thu cong (chong nhay ve cau cu).
        if (Date.now() < manualSelectUntil && p.idx !== manualSelectIdx) break;
        current = p.idx; renderNow(p); markCur(p.idx); break;
      case 'playstate': { const b = $('#btn-play-pause') || $('.cbtn.play'); if (b) { const ic = b.querySelector('.tb-ico') || b; ic.textContent = p.playing ? '⏸' : '▶'; const lb = b.querySelector('.tb-label'); if (lb) lb.textContent = p.playing ? t('bt_pause') : t('bt_play'); } break; }
      case 'loop': { const lb = $('#btn-loop'); if (lb) lb.classList.toggle('on', p); break; }
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
      playing: '▶️ ' + t('st_playing', 'Playing…'),
      paused: '⏸ ' + t('st_paused', 'Paused'),
      recording: '🎤 ' + t('st_listening'),
      transcribing: '⏳ ' + t('st_transcribing'),
      scoring: '🧮 ' + t('st_scoring'),
      ad: '📺 ' + t('st_ad', 'Waiting for ad to end…'),
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
    if (stxt) stxt.textContent = isRec ? t('st_listening') : isTranscribing ? t('st_transcribing') : isScore ? t('st_scoring') : t('st_ready');
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
    // Panel luyện (Chép/Điền/Ẩn chữ) đang mở → đồng bộ sang câu mới.
    refreshActivePanel();
    // Panel "Nói & chấm" đang mở:
    //  - Điều hướng Trước/Sau/Lặp trong lúc luyện (keepRecordPanel) → GIỮ panel mở cho câu
    //    mới + reset điểm để luyện tiếp (sửa lỗi: bấm Sau là panel biến mất, không hiện câu mới).
    //  - Đổi câu kiểu khác (click dòng khác) → đóng panel để không chấm nhầm câu cũ.
    const _rp = $('#record-panel');
    if (_rp && !_rp.hidden) {
      if (keepRecordPanel) {
        keepRecordPanel = false;
        recordPanelIdx = c.idx;
        updateRecordTarget();
        resetRecordPanelScoreUI();
      } else if (recordPanelIdx !== c.idx) {
        try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (_) {}
        showRecordPanel(false);
      }
    }
  }
  function markCur(i) { document.querySelectorAll('.row').forEach((r) => r.classList.toggle('cur', +r.dataset.i === i)); const r = document.querySelector('.row[data-i="' + i + '"]'); if (r) r.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

  // Anti snap-back guard cho dieu huong cau (xem selectRow + handleEvent 'current').
  let manualSelectIdx = -1, manualSelectUntil = 0;
  // Khi điều hướng Trước/Sau/Lặp lúc panel "Nói & chấm" đang mở → giữ panel mở cho câu mới.
  let keepRecordPanel = false;

  function isFav(t) { return favorites.some((f) => f.text === t); }

  // Chon mot cau trong danh sach (kieu ShadowEcho): KHONG nhay sang man luyen ngay.
  // Chi danh dau cau + phat doan video cua cau do, va cap nhat the "Luyen cau nay" o tren.
  // Nguoi dung bam "Nói & chấm" tren the (hoac nut mic duoi) moi bat dau ghi am.
  function selectRow(i) {
    if (i < 0 || i >= sentences.length) return;
    current = i;
    // Chong "snap-back": khi vua chon thu cong, bo qua su kien 'current' lac (idx khac)
    // tu engine trong ~750ms (luc playhead chua kip tua xong).
    manualSelectIdx = i;
    manualSelectUntil = Date.now() + 750;
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
    // Trạng thái nút ⭐ theo câu hiện tại
    const favB = $('#try-fav-btn');
    if (favB && s) {
      const on = isFav(s.text);
      favB.textContent = on ? '★' : '☆';
      favB.classList.toggle('on', on);
      favB.title = on ? 'Bỏ khỏi yêu thích' : 'Yêu thích câu này';
    }
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
    if (!sentences.length) { c.innerHTML = '<div class="empty">' + esc(t('empty_list')) + '</div>'; return; }
    if (!filtered.length) { c.innerHTML = '<div class="empty">' + esc(t('list_nofilter', 'Không có câu nào khớp bộ lọc.')) + '</div>'; return; }
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
      const de = document.createElement('div'); de.className = 'de'; wireWordLookup(de, s.text, { hoverOnly: true });
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
        const existing = body.querySelector('.tr');
        // Đã có bản dịch -> bật/tắt hiển thị.
        if (s.trans && existing) { existing.hidden = !existing.hidden; return; }
        if (transBtn.classList.contains('loading')) return;
        transBtn.classList.add('loading'); transBtn.disabled = true; transBtn.textContent = '⏳';
        try {
          const t = await translateText(s.text, settings.targetLang || 'de', settings.nativeLang || 'vi');
          if (t) {
            s.trans = t;
            let trEl = body.querySelector('.tr');
            if (!trEl) { trEl = document.createElement('div'); trEl.className = 'tr'; body.appendChild(trEl); }
            trEl.textContent = t; trEl.hidden = false;
            trEl.classList.remove('tr--in'); void trEl.offsetWidth; trEl.classList.add('tr--in');
          } else {
            transBtn.classList.add('err');
            setStatus('🌐 Không dịch được câu này — thử lại sau giây lát.', 'warn');
            setTimeout(() => transBtn.classList.remove('err'), 1600);
          }
        } catch (_) {
          setStatus('🌐 Lỗi dịch — thử lại sau.', 'warn');
        } finally {
          transBtn.classList.remove('loading'); transBtn.disabled = false; transBtn.textContent = '🌐';
        }
      };
      // Nut ⭐ — them/bo yeu thich (đồng bộ trạng thái thực từ storage)
      const favBtn = document.createElement('button'); favBtn.className = 'row-action-btn row-fav-btn';
      const setFavUI = () => {
        const on = isFav(s.text);
        favBtn.textContent = on ? '★' : '☆';
        favBtn.classList.toggle('on', on);
        favBtn.title = on ? 'Bỏ khỏi yêu thích' : 'Thêm vào yêu thích';
      };
      setFavUI();
      favBtn.onclick = async (e) => {
        e.stopPropagation();
        favBtn.classList.remove('fav-pop'); void favBtn.offsetWidth; favBtn.classList.add('fav-pop');
        const r = await cmd('fav', { text: s.text, trans: s.trans });
        if (r && r.favorites) favorites = r.favorites;
        setFavUI();
        if (typeof updateTryCard === 'function') updateTryCard();
        setStatus(isFav(s.text) ? t('sent_saved', '⭐ Đã lưu câu vào kho từ vựng.') : t('sent_unsaved', 'Đã bỏ câu khỏi kho.'), 'ok');
      };
      actions.appendChild(micBtn); actions.appendChild(transBtn); actions.appendChild(favBtn);
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
          body: JSON.stringify({ target, transcript, targetLang: settings.targetLang || 'de', nativeLang: settings.nativeLang || 'vi' }),
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
    const stxt = $('#record-status-text'); if (stxt) stxt.textContent = t('st_ready');
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

  // hover: none (cảm ứng) → bỏ hover, giữ click.
  const _canHover = !(window.matchMedia && window.matchMedia('(hover: none)').matches);
  function wireWordLookup(container, text, opts) {
    opts = opts || {};
    container.innerHTML = '';
    // To mau theo tan suat (kieu Language Reactor): chi cho tieng Duc
    const freqOn = (settings.targetLang || 'de') === 'de' && window.SD_FREQ_DE;
    text.split(/(\s+)/).forEach((w) => {
      if (/^\s*$/.test(w)) { container.appendChild(document.createTextNode(w)); return; }
      const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = w;
      if (freqOn && window.SD_FREQ_DE && !window.SD_FREQ_DE.isCommon(w)) sp.classList.add('freq-rare');
      // hoverOnly (danh sách câu): KHÔNG bắt click để click vẫn chọn câu; chỉ hover dịch.
      if (!opts.hoverOnly) sp.onclick = (e) => { e.stopPropagation(); lookup(w, text, e.clientX, e.clientY); };
      if (_canHover) {
        sp.addEventListener('mouseenter', () => { clearHoverTimers(); const r = sp.getBoundingClientRect(); _hoverTimer = setTimeout(() => hoverPopup(w, r.left, r.bottom), 350); });
        sp.addEventListener('mouseleave', () => scheduleHoverHide());
      }
      container.appendChild(sp);
    });
  }

  // ===== Popup HOVER (di chuột vào từ → dịch + IPA + 🔊), nhẹ hơn popup click =====
  let _hoverPop = null, _hoverTimer = null, _hoverHideTimer = null;
  function clearHoverTimers() { if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; } if (_hoverHideTimer) { clearTimeout(_hoverHideTimer); _hoverHideTimer = null; } }
  function removeHoverPop() { if (_hoverPop) { try { _hoverPop.remove(); } catch (_) {} _hoverPop = null; } }
  function scheduleHoverHide() { clearHoverTimers(); _hoverHideTimer = setTimeout(removeHoverPop, 220); }
  function hoverPopup(word, x, y) {
    removeHoverPop();
    const clean = String(word || '').replace(/[^A-Za-zÀ-ÿäöüÄÖÜß]/g, '');
    if (!clean) return;
    const lang = settings.targetLang || 'de';
    const pop = document.createElement('div');
    pop.className = 'pop pop--hover';
    pop.style.left = Math.min(x, innerWidth - 240) + 'px';
    pop.style.top = (y + 6) + 'px';
    pop.innerHTML =
      '<div class="pop-head"><b class="pop-word">' + esc(clean) + '</b>' +
      '<span class="pop-ipa"></span>' +
      '<button class="pop-tts" title="' + esc(t('pop_listen')) + '">🔊</button></div>' +
      '<div class="pop-trans">' + esc(t('pop_loading')) + '</div>';
    const ttsB = pop.querySelector('.pop-tts'); if (ttsB) ttsB.onclick = (e) => { e.stopPropagation(); speakText(clean); };
    pop.addEventListener('mouseenter', () => clearHoverTimers());
    pop.addEventListener('mouseleave', () => scheduleHoverHide());
    document.body.appendChild(pop);
    _hoverPop = pop;
    const gloss = pop.querySelector('.pop-trans');
    fetchGloss(clean).then((g) => { if (_hoverPop === pop && gloss) gloss.textContent = g || t('pop_nomean'); });
    fetchWordCard(clean, lang).then((c) => { if (_hoverPop === pop && c.ipa) { const ie = pop.querySelector('.pop-ipa'); if (ie) ie.textContent = c.ipa; } });
  }
  // Ẩn hover popup khi cuộn (vị trí cũ không còn đúng).
  window.addEventListener('scroll', removeHoverPop, true);
  function lookup(word, ctx, x, y) {
    document.querySelectorAll('.pop').forEach((p) => p.remove());
    const clean = word.replace(/[^A-Za-zäöüÄÖÜß]/g, '');
    const isDe = (settings.targetLang || 'de') === 'de';
    const pop = document.createElement('div');
    pop.className = 'pop pop--word';
    pop.style.left = Math.min(x, innerWidth - 230) + 'px';
    pop.style.top = (y + 8) + 'px';
    // Gợi ý phát âm (chỉ tiếng Đức) từ germanHints().
    let phonHtml = '';
    if (isDe) {
      const hints = germanHints(clean);
      if (hints.length) phonHtml = '<div class="pop-phon">🗣 ' + esc(t('pop_pron')) + ': ' +
        hints.map((h) => '<span class="pop-phon-c">' + esc(h.cluster) + '</span> ' + esc(h.hint)).join(' · ') + '</div>';
    }
    // Liên kết từ điển theo ngôn ngữ học: Đức → DWDS/LEO; Anh → Cambridge/Wiktionary.
    const links = isDe
      ? '<a target="_blank" href="https://www.dwds.de/wb/' + encodeURIComponent(clean) + '">DWDS</a>' +
        '<a target="_blank" href="https://dict.leo.org/german-english/' + encodeURIComponent(clean) + '">LEO</a>'
      : ((settings.targetLang || '') === 'en'
        ? '<a target="_blank" href="https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(clean) + '">Cambridge</a>' +
          '<a target="_blank" href="https://en.wiktionary.org/wiki/' + encodeURIComponent(clean) + '">Wiktionary</a>'
        : '');
    pop.innerHTML =
      '<div class="pop-head"><b class="pop-word">' + esc(clean) + '</b>' +
      '<span class="pop-ipa"></span>' +
      '<button class="pop-tts" title="' + esc(t('pop_listen')) + '">🔊</button></div>' +
      '<div class="pop-trans">' + esc(t('pop_loading')) + '</div>' +
      phonHtml +
      (links ? '<div class="pop-links">' + links + '</div>' : '') +
      '<div class="pop-actions"><button class="pop-save">⭐ ' + esc(t('pop_save')) + '</button></div>';
    pop.querySelector('.pop-tts').onclick = (e) => { e.stopPropagation(); speakText(clean); };
    const saveBtn = pop.querySelector('.pop-save');
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      cmd('saveWord', { word: clean, context: ctx, lang: settings.targetLang });
      markWordSaved(clean);
      saveBtn.textContent = '✅ ' + t('pop_saved');
      saveBtn.classList.add('saved'); saveBtn.disabled = true;
    };
    isWordSaved(clean).then((saved) => { if (saved) { saveBtn.textContent = '✅ ' + t('pop_saved'); saveBtn.classList.add('saved'); saveBtn.disabled = true; } });
    const gloss = pop.querySelector('.pop-trans');
    fetchGloss(clean).then((g) => { gloss.textContent = g || t('pop_nomean'); });
    fetchWordCard(clean, settings.targetLang).then((c) => { if (c.ipa) { const ie = pop.querySelector('.pop-ipa'); if (ie) ie.textContent = c.ipa; } });
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener('click', function h() { pop.remove(); document.removeEventListener('click', h); }), 50);
  }

  // ---- Vocabulary view: 2 tab (từ đã lưu / phát âm yếu) + khung chi tiết từ ----
  let _savedWordsCache = [];
  const wordCardCache = {};

  function vocabHint(word) {
    if ((settings.targetLang || 'de') !== 'de') return '';
    const h = germanHints(word); if (!h.length) return '';
    return '💡 ' + h.map((x) => '<span class="voc-hint-c">' + esc(x.cluster) + '</span> ' + esc(x.hint)).join(' · ');
  }

  // Tra IPA/định nghĩa/ví dụ từ dictionaryapi.dev (miễn phí, không key). Cache trong phiên.
  async function fetchWordCard(word, lang) {
    lang = lang || settings.targetLang || 'de';
    const clean = String(word || '').trim();
    if (!clean) return { ipa: '', def: '', example: '' };
    const ck = lang + '|' + clean.toLowerCase();
    if (wordCardCache[ck]) return wordCardCache[ck];
    const card = { ipa: '', def: '', example: '', related: [] };
    try {
      const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/' + encodeURIComponent(lang) + '/' + encodeURIComponent(clean));
      if (r.ok) {
        const j = await r.json();
        const entry = Array.isArray(j) ? j[0] : null;
        if (entry) {
          if (entry.phonetic) card.ipa = entry.phonetic;
          else if (Array.isArray(entry.phonetics)) { const p = entry.phonetics.find((x) => x && x.text); if (p) card.ipa = p.text; }
          const m = entry.meanings && entry.meanings[0];
          const d = m && m.definitions && m.definitions[0];
          if (d) { card.def = d.definition || ''; card.example = d.example || ''; }
          const rel = new Set();
          (entry.meanings || []).forEach((mm) => {
            (mm.synonyms || []).forEach((s) => rel.add(s));
            (mm.definitions || []).forEach((dd) => (dd.synonyms || []).forEach((s) => rel.add(s)));
          });
          card.related = Array.from(rel).filter((x) => x && x.toLowerCase() !== clean.toLowerCase()).slice(0, 6);
        }
      }
    } catch (_) {}
    wordCardCache[ck] = card; return card;
  }

  function vocabRow(w) {
    return '<div class="voc-row" data-w="' + esc(w.word) + '" role="button" tabindex="0">' +
      '<div class="voc-main"><b class="voc-w">' + esc(w.word) + '</b>' +
        '<span class="voc-ipa">' + esc(w.ipa || '') + '</span>' +
      '</div>' +
      '<div class="voc-row-actions">' +
        '<button class="voc-tts" title="' + esc(t('pop_listen')) + '">🔊</button>' +
        '<button class="voc-del" title="' + esc(t('voc_remove')) + '">🗑</button>' +
      '</div></div>';
  }

  async function renderVocabView() {
    const r = await cmd('vocab'); const words = (r && r.savedWords) || [];
    _savedWordsCache = words;
    savedWordSet = new Set(words.map((w) => (w.word || '').toLowerCase()));
    const box = $('#vocab-list');
    if (box) {
      if (!words.length) box.innerHTML = '<div class="voc-empty">' + esc(t('voc_empty')) + '</div>';
      else {
        box.innerHTML = words.map(vocabRow).join('');
        box.querySelectorAll('.voc-row').forEach((row) => {
          const word = row.dataset.w;
          const w = words.find((x) => x.word === word) || { word };
          const tts = row.querySelector('.voc-tts'); if (tts) tts.onclick = (e) => { e.stopPropagation(); speakText(word); };
          const del = row.querySelector('.voc-del'); if (del) del.onclick = async (e) => { e.stopPropagation(); await cmd('removeWord', { word }); markWordRemoved(word); renderVocabView(); };
          row.onclick = () => showVocabDetail(w);
          row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showVocabDetail(w); } };
          if (!w.ipa) {
            const ipaEl = row.querySelector('.voc-ipa');
            fetchWordCard(word, w.lang).then((c) => { if (c.ipa && ipaEl) { ipaEl.textContent = c.ipa; w.ipa = c.ipa; cmd('updateWord', { word, fields: { ipa: c.ipa } }); } });
          }
        });
      }
    }
    updateVocabFoot();
    renderWeakWords();
  }

  function updateVocabFoot() {
    const el = $('#vocab-foot-count'); if (!el) return;
    const weakOn = $('#weak-words-list') && !$('#weak-words-list').hidden;
    el.textContent = weakOn ? Object.values(weakWords).filter((e) => e.miss > 0).length : (_savedWordsCache ? _savedWordsCache.length : 0);
  }

  // Khung chi tiết 1 từ (IPA · nghĩa · định nghĩa · ví dụ · ghi chú · Quên/Ôn lại).
  async function showVocabDetail(w) {
    const box = $('#vocab-detail'); if (!box) return;
    const lang = w.lang || settings.targetLang || 'de';
    box.hidden = false;
    box.innerHTML = '<div class="vd-loading">' + esc(t('pop_loading', 'Đang tải…')) + '</div>';
    try { box.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    const [gloss, card] = await Promise.all([ fetchGloss(w.word).catch(() => ''), fetchWordCard(w.word, lang) ]);
    const ipa = w.ipa || card.ipa || '';
    const def = w.def || card.def || '';
    const example = w.example || w.context || card.example || '';
    const related = (Array.isArray(w.related) && w.related.length ? w.related : card.related) || [];
    box.innerHTML =
      '<div class="vd-head">' +
        '<div class="vd-head-main"><b class="vd-word">' + esc(w.word) + '</b>' + (ipa ? '<span class="vd-ipa">' + esc(ipa) + '</span>' : '') + '</div>' +
        '<button class="vd-tts" title="' + esc(t('pop_listen')) + '">🔊</button>' +
        '<button class="vd-close" title="' + esc(t('close', 'Đóng')) + '">✕</button>' +
      '</div>' +
      (gloss ? '<div class="vd-gloss">' + esc(gloss) + '</div>' : '') +
      (def ? '<div class="vd-block"><span class="vd-label" data-i18n="voc_def">Định nghĩa</span><div class="vd-text">' + esc(def) + '</div></div>' : '') +
      (example ? '<div class="vd-block"><span class="vd-label" data-i18n="voc_example">Ví dụ</span><div class="vd-text vd-ex">' + esc(example) + '</div></div>' : '') +
      '<div class="vd-block"><span class="vd-label" data-i18n="voc_notes">Ghi chú của bạn</span>' +
        '<textarea class="vd-notes" placeholder="' + esc(t('voc_notes_ph', 'Thêm ghi chú…')) + '">' + esc(w.notes || '') + '</textarea></div>' +
      (related.length ? '<div class="vd-block"><span class="vd-label" data-i18n="voc_related">Từ liên quan</span><div class="vd-chips">' + related.map((rw) => '<button class="vd-chip" data-rw="' + esc(rw) + '">' + esc(rw) + '</button>').join('') + '</div></div>' : '') +
      '<div class="vd-actions">' +
        '<button class="vd-forget" data-i18n="voc_forget">🗑 Quên từ này</button>' +
        '<button class="vd-review" data-i18n="voc_review_one">🔁 Ôn lại</button>' +
      '</div>';
    box.querySelectorAll('.vd-chip').forEach((c) => { c.onclick = () => showVocabDetail({ word: c.dataset.rw, lang }); });
    const ttsB = box.querySelector('.vd-tts'); if (ttsB) ttsB.onclick = () => speakText(w.word);
    const closeB = box.querySelector('.vd-close'); if (closeB) closeB.onclick = () => { box.hidden = true; };
    const ta = box.querySelector('.vd-notes'); if (ta) ta.onchange = () => { w.notes = ta.value; cmd('updateWord', { word: w.word, fields: { notes: ta.value } }); };
    const forgetB = box.querySelector('.vd-forget'); if (forgetB) forgetB.onclick = async () => { await cmd('removeWord', { word: w.word }); markWordRemoved(w.word); box.hidden = true; renderVocabView(); };
    const reviewB = box.querySelector('.vd-review'); if (reviewB) reviewB.onclick = () => { if (typeof openVocabGame === 'function') openVocabGame({ mode: 'speak', words: [w] }); };
    // Lưu lại card đã tra để lần sau khỏi gọi mạng.
    const patch = {};
    if (ipa && !w.ipa) { w.ipa = ipa; patch.ipa = ipa; }
    if (card.def && !w.def) { w.def = card.def; patch.def = card.def; }
    if (example && !w.example) { w.example = example; patch.example = example; }
    if (related.length && !(w.related && w.related.length)) { w.related = related; patch.related = related; }
    if (lang && !w.lang) { w.lang = lang; patch.lang = lang; }
    if (Object.keys(patch).length) cmd('updateWord', { word: w.word, fields: patch });
    applyI18n(settings.uiLang || 'vi');
  }

  function switchVocabTab(tab) {
    const isWeak = tab === 'weak';
    const sv = $('#vocab-tab-saved'), wv = $('#vocab-tab-weak');
    const sl = $('#vocab-list'), wl = $('#weak-words-list');
    if (sv) sv.classList.toggle('on', !isWeak);
    if (wv) wv.classList.toggle('on', isWeak);
    if (sl) sl.hidden = isWeak;
    if (wl) wl.hidden = !isWeak;
    const d = $('#vocab-detail'); if (d) d.hidden = true;
    updateVocabFoot();
  }

  async function playAllVocab() {
    const weakOn = $('#weak-words-list') && !$('#weak-words-list').hidden;
    const list = weakOn ? Object.values(weakWords).filter((e) => e.miss > 0).map((e) => e.word) : (_savedWordsCache || []).map((w) => w.word);
    for (const word of list) { try { speakText(word); } catch (_) {} await new Promise((r) => setTimeout(r, 1100)); }
  }

  { const b = $('#vocab-tab-saved'); if (b) b.onclick = () => switchVocabTab('saved'); }
  { const b = $('#vocab-tab-weak'); if (b) b.onclick = () => switchVocabTab('weak'); }
  { const b = $('#vocab-foot-play'); if (b) b.onclick = () => playAllVocab(); }
  { const b = $('#vocab-foot-game'); if (b) b.onclick = () => openVocabGame({ mode: 'menu' }); }

  // ===== 🎮 GAME ÔN TỪ VỰNG — tái dùng ĐÚNG pipeline chấm điểm (mic→Whisper→phonetic) + dịch =====
  let _vgState = null;
  function vgShuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; } return a; }
  function closeVocabGame() {
    const ov = $('#vocab-game'); if (ov) ov.hidden = true;
    _vgState = null;
    try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (_) {}
    try { speechSynthesis.cancel(); } catch (_) {}
  }
  async function gameLoadPool(kind) {
    if (kind === 'weak') return Object.values(weakWords).filter((e) => e.miss > 0).map((e) => ({ word: e.word, lang: settings.targetLang }));
    if (kind === 'sentences') { try { const r = await cmd('savedSentences'); return ((r && r.savedSentences) || []).map((s) => ({ word: s.text, trans: s.trans, sentence: true, lang: settings.targetLang })); } catch (_) { return []; } }
    try { const r = await cmd('vocab'); return ((r && r.savedWords) || []).map((w) => ({ word: w.word, trans: '', ipa: w.ipa, lang: w.lang || settings.targetLang })); } catch (_) { return []; }
  }
  async function openVocabGame(opts) {
    opts = opts || {};
    const ov = $('#vocab-game'); if (!ov) return;
    ov.hidden = false;
    if (!opts.mode || opts.mode === 'menu') { renderGameMenu(); return; }
    let pool = opts.words;
    if (!pool || !pool.length) pool = await gameLoadPool(opts.pool || 'saved');
    if (!pool.length) { renderGameMenu(t('game_empty', 'Chưa có từ nào để ôn — hãy lưu từ trước.')); return; }
    _vgState = { mode: opts.mode, pool: vgShuffle(pool), idx: 0, correct: 0 };
    renderGameStep();
  }
  function renderGameMenu(msg) {
    const body = $('#vg-body'); if (!body) return;
    const ttl = $('#vg-title'); if (ttl) ttl.textContent = t('game_title', '🎮 Ôn tập từ vựng');
    const modes = [
      { m: 'flashcard', icon: '🃏', label: t('game_flashcard', 'Lật thẻ') },
      { m: 'choice', icon: '🔤', label: t('game_choice', 'Trắc nghiệm') },
      { m: 'type', icon: '⌨️', label: t('game_type', 'Nghe & gõ') },
      { m: 'speak', icon: '🎤', label: t('game_speak', 'Nói & chấm') },
    ];
    body.innerHTML =
      (msg ? '<div class="vg-msg">' + esc(msg) + '</div>' : '') +
      '<div class="vg-pool"><label data-i18n="game_pool">Nguồn từ</label>' +
        '<select id="vg-pool-sel" class="setting-select">' +
          '<option value="saved">' + esc(t('voc_tab_saved', 'Từ đã lưu')) + '</option>' +
          '<option value="weak">' + esc(t('voc_tab_weak', 'Phát âm yếu')) + '</option>' +
          '<option value="sentences">' + esc(t('game_pool_sent', 'Câu đã lưu')) + '</option>' +
        '</select></div>' +
      '<div class="vg-modes">' + modes.map((x) => '<button class="vg-mode" data-m="' + x.m + '"><span class="vg-mode-ico">' + x.icon + '</span>' + esc(x.label) + '</button>').join('') + '</div>';
    body.querySelectorAll('.vg-mode').forEach((b) => { b.onclick = () => { const pool = ($('#vg-pool-sel') || {}).value || 'saved'; openVocabGame({ mode: b.dataset.m, pool }); }; });
  }
  function gameProgressHtml() { const s = _vgState; return s ? '<div class="vg-prog">' + (s.idx + 1) + ' / ' + s.pool.length + ' · ✓ ' + s.correct + '</div>' : ''; }
  function gameNext() { const s = _vgState; if (!s) return; s.idx++; if (s.idx >= s.pool.length) { renderGameDone(); return; } renderGameStep(); }
  function renderGameDone() {
    const s = _vgState; const body = $('#vg-body'); if (!body || !s) return;
    const pct = s.pool.length ? Math.round(s.correct / s.pool.length * 100) : 0;
    body.innerHTML = '<div class="vg-done"><div class="vg-done-pct">' + pct + '%</div>' +
      '<div class="vg-done-sub">' + esc(t('game_done', 'Hoàn thành!')) + ' ✓ ' + s.correct + '/' + s.pool.length + '</div>' +
      '<div class="vg-actions"><button class="vg-btn vg-btn--primary" id="vg-again">' + esc(t('game_again', '🔁 Chơi lại')) + '</button>' +
      '<button class="vg-btn" id="vg-menu">' + esc(t('game_menu', '☰ Chọn chế độ')) + '</button></div></div>';
    const a = $('#vg-again'); if (a) a.onclick = () => { _vgState.idx = 0; _vgState.correct = 0; _vgState.pool = vgShuffle(_vgState.pool); renderGameStep(); };
    const m = $('#vg-menu'); if (m) m.onclick = () => renderGameMenu();
  }
  function renderGameStep() {
    const s = _vgState; if (!s) return;
    if (s.mode === 'flashcard') return gameFlashcard();
    if (s.mode === 'choice') return gameChoice();
    if (s.mode === 'type') return gameType();
    if (s.mode === 'speak') return gameSpeak();
  }
  async function gameFlashcard() {
    const s = _vgState; const it = s.pool[s.idx]; const body = $('#vg-body'); if (!body) return;
    body.innerHTML = gameProgressHtml() +
      '<div class="vg-card"><div class="vg-word">' + esc(it.word) + '</div>' +
      '<button class="vg-tts" title="' + esc(t('pop_listen')) + '">🔊</button>' +
      '<div class="vg-back" id="vg-back" hidden></div></div>' +
      '<div class="vg-actions" id="vg-actions"><button class="vg-btn vg-btn--primary" id="vg-reveal">' + esc(t('game_reveal', 'Hiện nghĩa')) + '</button></div>';
    const tts = body.querySelector('.vg-tts'); if (tts) tts.onclick = () => speakText(it.word);
    $('#vg-reveal').onclick = async () => {
      const back = $('#vg-back'); back.textContent = it.trans || (await fetchGloss(it.word)) || '—'; back.hidden = false;
      $('#vg-actions').innerHTML = '<button class="vg-btn vg-btn--hard" id="vg-hard">' + esc(t('fc_hard', 'Khó')) + '</button><button class="vg-btn vg-btn--good" id="vg-good">' + esc(t('fc_good', 'Tốt')) + '</button>';
      $('#vg-hard').onclick = () => gameNext();
      $('#vg-good').onclick = () => { s.correct++; gameMarkLearned(it.word); gameNext(); };
    };
  }
  async function gameChoice() {
    const s = _vgState; const it = s.pool[s.idx]; const body = $('#vg-body'); if (!body) return;
    body.innerHTML = gameProgressHtml() + '<div class="vg-card"><div class="vg-word">' + esc(it.word) + '</div><button class="vg-tts">🔊</button></div><div class="vg-loading">' + esc(t('pop_loading', 'Đang tải…')) + '</div>';
    body.querySelector('.vg-tts').onclick = () => speakText(it.word);
    const correct = it.trans || (await fetchGloss(it.word)) || it.word;
    const others = vgShuffle(s.pool.filter((x) => x.word !== it.word)).slice(0, 6);
    const distr = [];
    for (const o of others) { if (distr.length >= 3) break; const g = o.trans || (await fetchGloss(o.word)); if (g && g !== correct && distr.indexOf(g) < 0) distr.push(g); }
    while (distr.length < 3) distr.push('—');
    const options = vgShuffle([correct].concat(distr));
    body.innerHTML = gameProgressHtml() + '<div class="vg-card"><div class="vg-word">' + esc(it.word) + '</div><button class="vg-tts">🔊</button></div>' +
      '<div class="vg-opts">' + options.map((o) => '<button class="vg-opt" data-c="' + (o === correct ? '1' : '0') + '">' + esc(o) + '</button>').join('') + '</div>';
    body.querySelector('.vg-tts').onclick = () => speakText(it.word);
    body.querySelectorAll('.vg-opt').forEach((b) => { b.onclick = () => {
      const ok = b.dataset.c === '1';
      body.querySelectorAll('.vg-opt').forEach((x) => { x.disabled = true; if (x.dataset.c === '1') x.classList.add('vg-opt--ok'); });
      if (ok) { s.correct++; gameMarkLearned(it.word); } else { b.classList.add('vg-opt--bad'); }
      setTimeout(gameNext, 850);
    }; });
  }
  function gameType() {
    const s = _vgState; const it = s.pool[s.idx]; const body = $('#vg-body'); if (!body) return;
    body.innerHTML = gameProgressHtml() +
      '<div class="vg-card"><button class="vg-tts vg-tts--big" title="' + esc(t('pop_listen')) + '">🔊 ' + esc(t('game_replay', 'Nghe lại')) + '</button></div>' +
      '<input class="vg-input" id="vg-input" type="text" autocomplete="off" placeholder="' + esc(t('game_type_ph', 'Gõ từ bạn nghe…')) + '">' +
      '<div class="vg-actions"><button class="vg-btn vg-btn--primary" id="vg-check">' + esc(t('game_check', 'Kiểm tra')) + '</button></div>' +
      '<div class="vg-result" id="vg-result" hidden></div>';
    speakText(it.word);
    body.querySelector('.vg-tts').onclick = () => speakText(it.word);
    const input = $('#vg-input'); if (input) { input.focus(); input.onkeydown = (e) => { if (e.key === 'Enter') doCheck(); }; }
    function doCheck() {
      const val = (($('#vg-input') || {}).value || '').trim().toLowerCase();
      const ok = val === String(it.word).trim().toLowerCase();
      const res = $('#vg-result'); res.hidden = false; res.className = 'vg-result ' + (ok ? 'ok' : 'bad');
      res.textContent = ok ? '✓ ' + t('game_correct', 'Chính xác!') : '✗ ' + it.word;
      if (ok) { s.correct++; gameMarkLearned(it.word); }
      setTimeout(gameNext, 1100);
    }
    const cb = $('#vg-check'); if (cb) cb.onclick = doCheck;
  }
  async function gameSpeak() {
    const s = _vgState; const it = s.pool[s.idx]; const body = $('#vg-body'); if (!body) return;
    body.innerHTML = gameProgressHtml() +
      '<div class="vg-card"><div class="vg-word">' + esc(it.word) + '</div><button class="vg-tts">🔊</button></div>' +
      '<div class="vg-actions"><button class="vg-btn vg-btn--primary" id="vg-rec">🎤 ' + esc(t('game_speak_btn', 'Nói')) + '</button><button class="vg-btn" id="vg-skip">' + esc(t('game_skip', 'Bỏ qua')) + '</button></div>' +
      '<div class="vg-result" id="vg-result" hidden></div>';
    body.querySelector('.vg-tts').onclick = () => speakText(it.word);
    const sk = $('#vg-skip'); if (sk) sk.onclick = () => gameNext();
    const rec = $('#vg-rec'); if (rec) rec.onclick = async () => {
      if (!window.ShadowMic || !window.ShadowMic.recordAndTranscribe) { setStatus(t('mic_not_ready', 'Mic chưa sẵn sàng — tải lại extension.'), 'warn'); return; }
      rec.disabled = true; rec.textContent = '● ' + t('st_listening', 'Đang nghe…');
      let res;
      try { res = await window.ShadowMic.recordAndTranscribe({ maxMs: 5000, lang2: it.lang || settings.targetLang || 'de', useSileroVad: !!settings.useSileroVad }); }
      catch (e) { res = { error: 'rec' }; }
      rec.disabled = false; rec.textContent = '🎤 ' + t('game_speak_btn', 'Nói');
      const res2 = $('#vg-result'); res2.hidden = false;
      if (!res || res.error || !res.transcript) { res2.className = 'vg-result bad'; res2.textContent = '✗ ' + t('empty_heard', 'Không nghe rõ — thử lại.'); return; }
      let score = null;
      try { if (window.SD && window.SD.phonetic) score = window.SD.phonetic.analyze(it.word, res.transcript, { lang: it.lang || settings.targetLang || 'de' }); } catch (_) {}
      const pct = score ? Math.round(score.overall) : 0;
      const ok = pct >= 70;
      res2.className = 'vg-result ' + (ok ? 'ok' : 'bad');
      res2.textContent = (ok ? '✓ ' : '✗ ') + pct + '% · ' + t('you_said', 'Bạn nói') + ': ' + (res.transcript || '');
      if (ok) { s.correct++; gameMarkLearned(it.word); }
      setTimeout(gameNext, 1600);
    };
  }
  function gameMarkLearned(word) {
    const key = String(word || '').toLowerCase();
    if (weakWords[key] && weakWords[key].miss > 0) { weakWords[key].miss--; if (weakWords[key].miss <= 0) delete weakWords[key]; try { chrome.storage.local.set({ [WEAK_KEY]: weakWords }); } catch (_) {} }
  }
  { const b = $('#vg-close'); if (b) b.onclick = closeVocabGame; }
  { const ov = $('#vocab-game'); if (ov) ov.onclick = (e) => { if (e.target === ov) closeVocabGame(); }; }

  function markWordRemoved(word) { if (savedWordSet) savedWordSet.delete(String(word || '').toLowerCase()); }

  // ---- Controls / commands ----
  document.querySelectorAll('[data-cmd]').forEach((b) => {
    const c = b.dataset.cmd;
    if (['loadAuto', 'prev', 'next', 'togglePlay', 'stop'].includes(c)) b.onclick = () => {
      if (c === 'stop') { try { window.ShadowMic && window.ShadowMic.abortRecording(); } catch (e) {} pageMicSignal('abort'); const fb = $('#finalizeBtn'); if (fb) fb.hidden = true; }
      cmd(c, { target: settings.targetLang, native: settings.nativeLang });
    };
    if (c === 'mic') b.onclick = () => enableMic();
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
  // Ngôn ngữ HỌC/DỊCH: lưu + đẩy xuống content script (tự nạp lại track) + xoá cache + render lại.
  { const el = $('#target'); if (el) el.onchange = () => { settings.targetLang = el.value; cmd('settings', settings); onLearningLangChanged(); }; }
  { const el = $('#native'); if (el) el.onchange = () => { settings.nativeLang = el.value; cmd('settings', settings); onLearningLangChanged(); }; }
  bindSetting('serverurl', 'serverUrl', 'str');
  // Công tắc master Bật/Tắt extension — đồng bộ 2 chiều với chip ON/OFF trên video.
  { const sw = $('#extEnabled'); if (sw) sw.onchange = () => {
    settings.extEnabled = sw.checked;
    cmd('extEnabled', { on: sw.checked });
    applyMasterUI(sw.checked);
    setStatus(sw.checked ? t('ext_on', 'Đã bật extension') : t('ext_off', 'Đã tắt extension'), sw.checked ? 'ok' : 'warn');
  }; }
  $('#vsubs').onchange = (e) => { settings.videoSubs = e.target.checked; cmd('settings', settings); cmd('vsubs', { on: e.target.checked }); };
  $('#uilang').onchange = (e) => {
    settings.uiLang = e.target.value; cmd('settings', settings); applyI18n(settings.uiLang);
    // Render lại các view động để chuỗi đổi ngôn ngữ ngay (không sót tiếng cũ).
    try { refreshActivePanel(); } catch (_) {}
    try { renderList(); } catch (_) {}
    try { const sv = $('#section-vocab'); if (sv && sv.open) renderVocabView(); } catch (_) {}
  };
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
    if ($('#extEnabled')) $('#extEnabled').checked = settings.extEnabled !== false;
    applyMasterUI(settings.extEnabled !== false);
    applyBlur(!!settings.hideText);
    applyI18n(settings.uiLang || 'vi');
  }

  // Phản ánh trạng thái master ON/OFF lên giao diện side panel.
  function applyMasterUI(on) {
    document.body.classList.toggle('ext-off', !on);
    const sw = $('#extEnabled'); if (sw) sw.checked = !!on;
  }

  // Đổi ngôn ngữ HỌC/DỊCH: xoá cache dịch + render lại các view phụ thuộc ngôn ngữ.
  // (Việc nạp lại track phụ đề do content script xử lý trong case 'settings'/'reloadForLang'.)
  function onLearningLangChanged() {
    try { for (const k in transCache) delete transCache[k]; } catch (_) {}
    try { for (const k in glossCache) delete glossCache[k]; } catch (_) {}
    try { renderList(); } catch (_) {}
    try { if (sentences[current]) renderNow({ idx: current, total: sentences.length, sentence: sentences[current] }); } catch (_) {}
    try { refreshActivePanel(); } catch (_) {}
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
    if (!r || !r.ok) { showNoHost(true); sentences = []; renderList(); return; }
    showNoHost(false);
    settings = Object.assign(settings, r.settings || {}); favorites = r.favorites || []; sentences = r.sentences || []; current = r.current || 0;
    applySettings(); renderList(); if (sentences[current]) renderNow({ idx: current, total: sentences.length, sentence: sentences[current] });
  }

  // Listen for tab changes
  chrome.tabs.onActivated.addListener(refresh);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') refresh(); });

  // ===== A0: Đồng bộ realtime qua chrome.storage.onChanged =====
  // Chip ON/OFF trên video, đổi ngôn ngữ học, hoặc đổi giao diện ở nơi khác → panel cập nhật ngay.
  // Diff với `settings` hiện tại nên thay đổi do CHÍNH panel này gây ra sẽ là no-op (không vòng lặp).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.sd_data_v1) return;
      const nv = (changes.sd_data_v1.newValue && changes.sd_data_v1.newValue.settings) || null;
      if (!nv) return;
      if (nv.extEnabled !== undefined && nv.extEnabled !== settings.extEnabled) {
        settings.extEnabled = nv.extEnabled; applyMasterUI(nv.extEnabled !== false);
      }
      if (nv.uiLang && nv.uiLang !== settings.uiLang) {
        settings.uiLang = nv.uiLang;
        const ul = $('#uilang'); if (ul) ul.value = nv.uiLang;
        applyI18n(nv.uiLang); try { refreshActivePanel(); } catch (_) {}
      }
      if ((nv.targetLang && nv.targetLang !== settings.targetLang) || (nv.nativeLang && nv.nativeLang !== settings.nativeLang)) {
        settings.targetLang = nv.targetLang || settings.targetLang;
        settings.nativeLang = nv.nativeLang || settings.nativeLang;
        const te = $('#target'); if (te) te.value = settings.targetLang;
        const ne = $('#native'); if (ne) ne.value = settings.nativeLang;
        onLearningLangChanged();
      }
    });
  } catch (_) {}

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

  // Dịch qua BACKGROUND service worker (Microsoft → Google → MyMemory). Background SW
  // không bị page-CSP/CORS và giữ token Microsoft riêng → ổn định hơn gọi trực tiếp.
  function bgTranslate(text, from, to) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ sd: 'translate', text, from, to }, (res) => {
          if (chrome.runtime.lastError) { resolve(''); return; }
          resolve((res && res.ok && res.text) || '');
        });
      } catch (_) { resolve(''); }
    });
  }

  const _transFail = {}; // negative-cache: ck -> timestamp (tránh gọi dồn dập khi vừa fail hết)

  async function translateText(text, from, to) {
    if (!text) return '';
    if (from && to && from === to) return text; // học = dịch sang cùng ngôn ngữ → khỏi dịch
    const ck = from + '|' + to + '|' + text;
    if (transCache[ck]) return transCache[ck];
    if (_transFail[ck] && Date.now() - _transFail[ck] < 30000) return ''; // vừa thất bại → chờ 30s

    // Thứ tự: background SW (chắc chắn) → DeepL → Google → Microsoft → MyMemory.
    // Mỗi nguồn đều KIỂM TRA kết quả; rỗng/sai thì hạ xuống nguồn kế. Thử 2 vòng có backoff.
    const attempts = [
      () => bgTranslate(text, from, to),
      () => deeplTranslate(text, from, to),
      () => googleFreeTranslate(text, from, to),
      () => microsoftFreeTranslate(text, from, to),
      () => myMemoryTranslate(text, from, to),
    ];
    for (let pass = 0; pass < 2; pass++) {
      for (const fn of attempts) {
        try { const out = await fn(); if (validTrans(out, text, from, to)) { transCache[ck] = out; delete _transFail[ck]; return out; } } catch (e) {}
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 500)); // backoff trước vòng 2
    }
    // Tầng CUỐI: AI qua Worker (tốn quota → để cuối) khi đã đăng nhập.
    try {
      if (typeof ShadowAuth !== 'undefined' && ShadowAuth.isLoggedIn() && !_quotaHitAI) {
        const ai = await openrouterTranslate(text, from, to, OR_MODELS[0]);
        if (validTrans(ai, text, from, to)) { transCache[ck] = ai; delete _transFail[ck]; return ai; }
      }
    } catch (e) {}

    // Tất cả nguồn dịch đều thất bại — ghi negative-cache + báo về Worker /log để theo dõi.
    _transFail[ck] = Date.now();
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
    const from = settings.targetLang || 'de';
    const to = settings.nativeLang || 'vi';
    const ck = from + '|' + to + '|' + word;
    if (glossCache[ck]) return glossCache[ck];
    const g = await translateText(word, from, to);
    glossCache[ck] = g; return g;
  }

  // Cache danh sách từ đã lưu để popup phản ánh trạng thái "Đã lưu".
  let savedWordSet = null;
  async function isWordSaved(word) {
    if (!savedWordSet) {
      try { const r = await cmd('vocab'); savedWordSet = new Set(((r && r.savedWords) || []).map((w) => (w.word || '').toLowerCase())); }
      catch (e) { savedWordSet = new Set(); }
    }
    return savedWordSet.has(String(word || '').toLowerCase());
  }
  function markWordSaved(word) { if (savedWordSet) savedWordSet.add(String(word || '').toLowerCase()); }

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
  // Theo dõi cho MỌI ngôn ngữ học (gợi ý phát âm chỉ hiển thị cho tiếng Đức).
  function recordWeakWords(scoreWords) {
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
      .sort((a, b) => b.miss - a.miss || b.updatedAt - a.updatedAt).slice(0, 60);
    if (!arr.length) { box.innerHTML = '<div class="voc-empty">' + esc(t('weak_empty')) + '</div>'; updateVocabFoot(); return; }
    box.innerHTML = arr.map((e) =>
      '<div class="voc-row voc-row--weak" data-w="' + esc(e.word) + '" role="button" tabindex="0">' +
        '<div class="voc-main"><b class="voc-w">' + esc(e.word) + '</b>' +
        '<span class="weak-word-count" title="' + esc(t('weak_miss')) + '">×' + e.miss + '</span></div>' +
        '<div class="voc-row-actions">' +
          '<button class="voc-tts" title="' + esc(t('pop_listen')) + '">🔊</button>' +
          '<button class="voc-del" title="' + esc(t('voc_remove')) + '">🗑</button>' +
        '</div></div>').join('');
    box.querySelectorAll('.voc-row').forEach((row) => {
      const word = row.dataset.w; const key = word.toLowerCase();
      const tts = row.querySelector('.voc-tts'); if (tts) tts.onclick = (e) => { e.stopPropagation(); speakText(word); };
      const del = row.querySelector('.voc-del'); if (del) del.onclick = (e) => {
        e.stopPropagation(); delete weakWords[key]; try { chrome.storage.local.set({ [WEAK_KEY]: weakWords }); } catch (_) {} renderWeakWords();
      };
      row.onclick = () => showVocabDetail({ word, lang: settings.targetLang });
    });
    updateVocabFoot();
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
      cmd('settings', settings); // push to content script (cũng tự nạp lại track theo ngôn ngữ)
      onLearningLangChanged();
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
    // Thẻ ghi nhớ = CÁC CÂU đã yêu thích (front = câu gốc, back = bản dịch). KHÔNG dùng từ lẻ.
    let favs = favorites; // `favorites` cập nhật từ content script qua getState()
    if (!favs || !favs.length) {
      try { const r2 = await cmd('getState'); if (r2 && r2.favorites) { favorites = r2.favorites; favs = favorites; } } catch (e) {}
    }
    favs = favs || [];
    const r = await chrome.storage.local.get(FLASH_KEY);
    const srsData = r[FLASH_KEY] || {};

    flashCards = favs.map((fav) => {
      const srs = srsData[fav.text] || { interval: 1, ease: 2.5, due: 0, reviews: 0 };
      // Bản dịch: ưu tiên trans đã có, hoặc lấy từ câu đang nạp; nếu chưa có sẽ dịch lúc lật thẻ.
      const match = sentences.find((s) => s.text === fav.text);
      return { text: fav.text, trans: fav.trans || (match && match.trans) || '', srs };
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

  // Panel luyện đang mở (Chép/Điền/Ẩn chữ) — để đồng bộ theo câu khi bấm Trước/Sau.
  let activePanel = null; // { type:'dict'|'cloze'|'recall', diff?:'easy'|'medium'|'hard' }
  let recordPanelIdx = null; // câu mà panel "Nói & chấm" đang mở cho — để đóng khi đổi câu
  function closeActivePanel() { activePanel = null; const b = $('#dictbox'); if (b) b.hidden = true; updatePracticeBlur(); }
  // Làm mờ phụ đề bên ngoài khi BẤT KỲ panel luyện nào đang mở (Chép/Điền/Ẩn chữ/Nói & chấm)
  // → buộc người dùng nhớ/đọc, không bị lộ đáp án.
  function updatePracticeBlur() {
    const dict = $('#dictbox'); const rec = $('#record-panel');
    const open = (dict && !dict.hidden) || (rec && !rec.hidden);
    // Practice view (màn câu đang luyện)
    const vp = $('#view-practice'); if (vp) vp.classList.toggle('panel-active', open);
    // List view (màn danh sách + thẻ "Luyện câu này")
    const vl = $('#view-list'); if (vl) vl.classList.toggle('panel-active', open);
    // Overlay mờ nền trong list view
    const ov = $('#blur-overlay'); if (ov) ov.hidden = !open;
  }
  // Khi đổi câu (prev/next/select): nếu panel đang mở thì vẽ lại theo câu mới (không tự đọc).
  function refreshActivePanel() {
    if (!activePanel) return;
    const box = $('#dictbox');
    if (!box || box.hidden) { activePanel = null; return; }
    if (!sentences[current]) return;
    if (activePanel.idx === current) return; // cùng câu → không vẽ lại (tránh mất chữ đang gõ)
    if (activePanel.type === 'dict') startDictation(true);
    else if (activePanel.type === 'recall') startRecall(true);
    else if (activePanel.type === 'cloze') {
      if (activePanel.diff) runCloze(sentences[current], activePanel.diff, box, true);
      else startCloze(true);
    }
  }

  function startDictation(silent) {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    if (!silent) speakText(s.text);
    activePanel = { type: 'dict', idx: current };
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
    updatePracticeBlur();
    $('#dictin').focus();
    $('#dictplay').onclick = () => speakText(s.text);
    $('#dictclose').onclick = () => closeActivePanel();
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

  // ===== Ẩn chữ — luồng: Nghe → Gõ lại câu → Hiện đáp án =====
  function startRecall(silent) {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    if (!silent) speakText(s.text);
    activePanel = { type: 'recall', idx: current };
    const box = $('#dictbox');
    box.className = 'dictbox as-panel as-panel--fill';
    box.hidden = false;
    updatePracticeBlur();
    box.innerHTML =
      '<div class="dp-header">' +
        '<span class="dp-title">🙈 Nghe → Gõ → Hiện</span>' +
        '<button class="dp-close" id="recallClose">&#10005;</button>' +
      '</div>' +
      '<div class="dp-body dp-body--fill">' +
        // Bước 1: Nghe
        '<div class="recall-step">' +
          '<div class="recall-step-label"><span class="recall-step-num">1</span> Nghe c&#226;u</div>' +
          '<button class="dp-btn" id="recallPlay">&#128266; Nghe l&#7841;i</button>' +
        '</div>' +
        // Bước 2: Gõ lại câu — ô gõ lấp đầy khung
        '<div class="recall-step recall-step--grow">' +
          '<div class="recall-step-label"><span class="recall-step-num">2</span> G&#245; l&#7841;i c&#226;u</div>' +
          '<div class="recall-type-area recall-type-area--fill"><textarea id="recallTypeIn" placeholder="G&#245; l&#7841;i to&#224;n b&#7897; c&#226;u b&#7841;n v&#7915;a nghe&#8230;"></textarea></div>' +
          '<div class="recall-type-res" id="recallTypeRes"></div>' +
        '</div>' +
        // Bước 3: Câu gốc — bấm/Kiểm tra để hiện (trước là bước 2)
        '<div class="recall-step">' +
          '<div class="recall-step-label"><span class="recall-step-num">3</span> C&#226;u g&#7889;c (b&#7845;m &#273;&#7875; hi&#7879;n)</div>' +
          '<div class="recall-hidden res" id="recallText" style="cursor:pointer;font-size:14px;line-height:1.6;padding:8px 10px;border-radius:10px;background:#f8f9fa">' + esc(s.text) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="dp-footer">' +
        '<button class="dp-btn" id="recallReveal">&#128065; Hi&#7879;n &#273;&#225;p &#225;n</button>' +
        '<button class="dp-btn dp-btn--primary" id="recallCheck">Ki&#7875;m tra</button>' +
      '</div>';

    const txt = $('#recallText');
    const revealAnim = () => {
      if (!txt) return;
      txt.classList.remove('recall-reveal-anim');
      void txt.offsetWidth;
      txt.classList.add('recall-reveal-anim');
    };
    const reveal = () => { if (txt) { txt.classList.remove('recall-hidden'); revealAnim(); } };

    $('#recallPlay').onclick = () => speakText(s.text);
    $('#recallClose').onclick = () => closeActivePanel();
    if (txt) txt.onclick = reveal;
    $('#recallReveal').onclick = reveal;

    const inp = $('#recallTypeIn');
    $('#recallCheck').onclick = () => {
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
      reveal(); // luôn hiện đáp án sau khi kiểm tra để so sánh
      if (pct >= 80) miniConfetti(resEl, 16);
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
      if (info) info.innerHTML = '<div class="flash-empty">' + esc(t('flash_empty')) + '</div>';
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
      back.textContent = card.trans || t('pop_loading');
      back.hidden = !flashRevealed;
      if (flashRevealed && !card.trans) ensureFlashTrans(card, back);
    }

    if (hardBtn) hardBtn.disabled = false;
    if (goodBtn) goodBtn.disabled = false;

    // Tap to reveal — lật thẻ để xem bản dịch (dịch ngay nếu chưa có).
    const flashCardEl = document.querySelector('.flash-card');
    if (flashCardEl) {
      flashCardEl.onclick = () => {
        flashRevealed = true;
        if (back) { back.hidden = false; if (!card.trans) { back.textContent = t('pop_loading'); ensureFlashTrans(card, back); } }
      };
    }
  }

  // Dịch câu của thẻ (front = câu gốc) sang ngôn ngữ mẹ đẻ khi cần.
  async function ensureFlashTrans(card, backEl) {
    if (!card || card.trans) return;
    try {
      const tr = await translateText(card.text, settings.targetLang, settings.nativeLang);
      if (tr) { card.trans = tr; if (backEl && flashCards[currentFlashIdx] === card) backEl.textContent = tr; }
    } catch (e) {}
  }


  // ===== Đọc mẫu theo ngôn ngữ học =====
  const BCP = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ru: 'ru-RU', nl: 'nl-NL' };
  function speakText(t) { cmd('speak', { text: t, rate: settings.rate, lang: BCP[settings.targetLang] || 'de-DE' }); }

  // ===== i18n (vi/en) — thương hiệu "NghienDeutsch" KHÔNG dịch =====
  const I18N = {
    vi: {
      tab_practice:'Luyện', tab_vocab:'Từ vựng', tab_flash:'Thẻ', tab_progress:'Tiến độ',
      nohost:'Mở một video YouTube hoặc Netflix rồi quay lại đây.',
      ob_title:'Bắt đầu nhanh', ob1:'Mở video tiếng Đức trên YouTube.', ob2:'Phụ đề tự tải sau vài giây — không cần thao tác.', ob3:'Bấm "Bật mic", cho phép micro cho extension.', ob4:'Bấm một câu → nói lại → xem điểm.', ob_close:'Đã hiểu',
      status_init:'Mở video trên YouTube — phụ đề sẽ tự tải.',
      // Cài đặt
      sec_settings:'Cài đặt', set_target:'Ngôn ngữ học', set_native:'Dịch sang', set_vsubs:'Phụ đề trên video', set_uilang:'Ngôn ngữ giao diện',
      // Action toolbar
      at_mic:'Bật mic', at_dict:'Chép', at_cloze:'Điền', at_vocab:'Từ vựng', at_menu:'Menu',
      tt_mic:'Cho phép micro để chấm điểm phát âm', tt_dict:'Chép chính tả: nghe rồi gõ lại cả câu', tt_cloze:'Điền từ còn thiếu vào chỗ trống', tt_vocab:'Từ vựng đã lưu & từ phát âm yếu', tt_menu:'Mở menu cài đặt', tt_loop:'Lặp lại 1 câu (phím L)',
      // Bottom toolbar
      bt_prev:'Trước', bt_play:'Phát', bt_pause:'Dừng', bt_next:'Sau', bt_loop:'Lặp',
      t_prev:'Câu trước', t_play:'Phát/Dừng', t_loop:'Lặp 1 câu', t_next:'Câu sau', t_shadow:'Luyện', t_listen:'Nghe', t_dict:'Chép chính tả', t_cloze:'Điền chỗ trống', t_blur:'Ẩn chữ (tự kiểm tra)',
      kbd_hint:'⌨ Space: nói · ◀ ▶: câu · ▲ ▼: tốc độ · R: nghe · L: lặp · B: ẩn chữ',
      // Try-card
      tc_title:'Luyện câu này', tc_pause_on:'⏸ Tự dừng: Bật', tc_pause_off:'▶ Tự dừng: Tắt', tc_pause_msg_on:'⏸ Tự dừng cuối mỗi câu: BẬT', tc_pause_msg_off:'▶ Tự dừng cuối mỗi câu: TẮT', tc_next:'Câu sau ›', tc_listen:'▷ Nghe', tc_speak:'🎤 Nói & chấm', tc_fav:'Yêu thích câu này',
      // Record panel
      rp_ready:'Sẵn sàng', rp_target:'Đang luyện', rp_match:'Độ khớp %', rp_yousaid:'BẠN ĐÃ NÓI',
      rp_listen:'🔊 Nghe mẫu', rp_replay:'🔁 Nghe lại', rescore_go:'🎤 Chấm điểm', rescore_stop:'⏹ Dừng & chấm', wd_speak:'🔊 Nghe phát âm đúng',
      // Slide menu
      menu_title:'Menu', menu_logout:'Đăng xuất', usage_trans:'Dịch hôm nay', usage_ai:'AI hôm nay', btn_upgrade:'⚡ Nâng cấp Pro',
      sec_vocab:'Từ vựng', sec_flash:'Thẻ ghi nhớ', voc_saved_title:'📚 Từ đã lưu', voc_weak_title:'⚠️ Từ phát âm yếu', fc_hard:'Khó', fc_good:'Tốt', fc_skip:'Bỏ qua', flash_empty:'⭐ Thêm câu yêu thích để bắt đầu luyện thẻ ghi nhớ!',
      // Word popup
      pop_listen:'Nghe', pop_save:'Lưu', pop_saved:'Đã lưu', pop_loading:'… đang tra nghĩa', pop_nomean:'(không có nghĩa)', pop_pron:'Phát âm',
      voc_remove:'Xoá', voc_empty:'Chưa lưu từ nào. Bấm vào từ trong câu rồi ⭐ Lưu.', weak_empty:'Chưa có từ yếu — luyện thêm để theo dõi! 💪', weak_miss:'Số lần đọc sai',
      // Trạng thái động
      st_listening:'Đang nghe…', st_transcribing:'Đang nhận dạng…', st_scoring:'Đang chấm…', st_ready:'Sẵn sàng', st_playing:'Đang phát…', st_paused:'Đã tạm dừng', st_ad:'Đang chờ quảng cáo kết thúc…',
      stop:'⏹ Dừng', finalize:'✅ Tôi nói xong → chấm', fav_run:'▶️ Tự luyện dòng ⭐',
      empty_list:'Chưa có phụ đề. Mở video trên YouTube — phụ đề sẽ tự tải.', pr_back:'← Quay lại',
      // Master toggle + câu đã lưu + vocab redesign + game
      set_master:'Bật extension', ext_on:'Đã bật extension', ext_off:'Đã tắt extension',
      sent_saved:'⭐ Đã lưu câu vào kho từ vựng.', sent_unsaved:'Đã bỏ câu khỏi kho.', trans_unavailable:'🌐 Tạm thời không dịch được — thử lại sau.',
      voc_tab_saved:'📚 Từ đã lưu', voc_tab_weak:'⚠️ Phát âm yếu', voc_total:'từ', voc_play_all:'▶ Phát tất cả', voc_review:'🎮 Ôn tập',
      voc_def:'Định nghĩa', voc_example:'Ví dụ', voc_notes:'Ghi chú của bạn', voc_notes_ph:'Thêm ghi chú…', voc_related:'Từ liên quan', voc_review_one:'🔁 Ôn lại', voc_forget:'🗑 Quên từ này', close:'Đóng',
      game_title:'🎮 Ôn tập từ vựng', game_empty:'Chưa có từ nào để ôn — hãy lưu từ trước.', game_flashcard:'Lật thẻ', game_choice:'Trắc nghiệm', game_type:'Nghe & gõ', game_speak:'Nói & chấm',
      game_pool:'Nguồn từ', game_pool_sent:'Câu đã lưu', game_reveal:'Hiện nghĩa', game_done:'Hoàn thành!', game_again:'🔁 Chơi lại', game_menu:'☰ Chọn chế độ', game_correct:'Chính xác!', game_check:'Kiểm tra', game_type_ph:'Gõ từ bạn nghe…', game_replay:'Nghe lại', game_speak_btn:'Nói', game_skip:'Bỏ qua',
      you_said:'Bạn nói', empty_heard:'Không nghe rõ — thử lại.', mic_not_ready:'Mic chưa sẵn sàng — tải lại extension.',
    },
    en: {
      tab_practice:'Practice', tab_vocab:'Words', tab_flash:'Cards', tab_progress:'Progress',
      nohost:'Open a YouTube or Netflix video, then come back here.',
      ob_title:'Quick start', ob1:'Open a German video on YouTube.', ob2:'Subtitles load automatically after a few seconds — no action needed.', ob3:'Click "Enable mic" and allow microphone access for the extension.', ob4:'Click a line → speak it back → see your score.', ob_close:'Got it',
      status_init:'Open a video on YouTube — subtitles load automatically.',
      sec_settings:'Settings', set_target:'Target language', set_native:'Translate to', set_vsubs:'Subtitles on video', set_uilang:'UI language',
      at_mic:'Enable mic', at_dict:'Dictation', at_cloze:'Fill', at_vocab:'Vocabulary', at_menu:'Menu',
      tt_mic:'Allow microphone to score pronunciation', tt_dict:'Dictation: listen then type the whole sentence', tt_cloze:'Fill in the missing words', tt_vocab:'Saved words & weak pronunciation words', tt_menu:'Open settings menu', tt_loop:'Loop one sentence (key L)',
      bt_prev:'Prev', bt_play:'Play', bt_pause:'Pause', bt_next:'Next', bt_loop:'Loop',
      t_prev:'Previous', t_play:'Play/Pause', t_loop:'Loop one', t_next:'Next', t_shadow:'Practice', t_listen:'Listen', t_dict:'Dictation', t_cloze:'Fill blanks', t_blur:'Hide text (self-test)',
      kbd_hint:'⌨ Space: speak · ◀ ▶: line · ▲ ▼: speed · R: listen · L: loop · B: hide',
      tc_title:'Practice this sentence', tc_pause_on:'⏸ Auto-pause: On', tc_pause_off:'▶ Auto-pause: Off', tc_pause_msg_on:'⏸ Auto-pause at each sentence: ON', tc_pause_msg_off:'▶ Auto-pause at each sentence: OFF', tc_next:'Next ›', tc_listen:'▷ Listen', tc_speak:'🎤 Speak & score', tc_fav:'Favorite this sentence',
      rp_ready:'Ready', rp_target:'Practicing', rp_match:'Match %', rp_yousaid:'YOU SAID',
      rp_listen:'🔊 Listen', rp_replay:'🔁 Replay', rescore_go:'🎤 Score', rescore_stop:'⏹ Stop & score', wd_speak:'🔊 Hear correct pronunciation',
      menu_title:'Menu', menu_logout:'Log out', usage_trans:'Translations today', usage_ai:'AI today', btn_upgrade:'⚡ Upgrade to Pro',
      sec_vocab:'Vocabulary', sec_flash:'Flashcards', voc_saved_title:'📚 Saved words', voc_weak_title:'⚠️ Weak words', fc_hard:'Hard', fc_good:'Good', fc_skip:'Skip', flash_empty:'⭐ Add favorite sentences to start practicing flashcards!',
      pop_listen:'Listen', pop_save:'Save', pop_saved:'Saved', pop_loading:'… looking up', pop_nomean:'(no translation)', pop_pron:'Pronounce',
      voc_remove:'Remove', voc_empty:'No saved words yet. Click a word in a sentence, then ⭐ Save.', weak_empty:'No weak words yet — keep practicing! 💪', weak_miss:'Times mispronounced',
      st_listening:'Listening…', st_transcribing:'Transcribing…', st_scoring:'Scoring…', st_ready:'Ready', st_playing:'Playing…', st_paused:'Paused', st_ad:'Waiting for ad to end…',
      stop:'⏹ Stop', finalize:'✅ Done speaking → score', fav_run:'▶️ Practice ⭐ lines',
      empty_list:'No subtitles yet. Open a video on YouTube — subtitles load automatically.', pr_back:'← Back',
      set_master:'Enable extension', ext_on:'Extension on', ext_off:'Extension off',
      sent_saved:'⭐ Sentence saved to your vocabulary.', sent_unsaved:'Sentence removed.', trans_unavailable:'🌐 Translation unavailable — try again later.',
      voc_tab_saved:'📚 Saved words', voc_tab_weak:'⚠️ Weak words', voc_total:'words', voc_play_all:'▶ Play all', voc_review:'🎮 Review',
      voc_def:'Definition', voc_example:'Example', voc_notes:'Your notes', voc_notes_ph:'Add a note…', voc_related:'Related words', voc_review_one:'🔁 Review', voc_forget:'🗑 Forget this word', close:'Close',
      game_title:'🎮 Vocabulary review', game_empty:'No words to review — save some words first.', game_flashcard:'Flashcards', game_choice:'Multiple choice', game_type:'Listen & type', game_speak:'Speak & score',
      game_pool:'Word source', game_pool_sent:'Saved sentences', game_reveal:'Reveal', game_done:'Done!', game_again:'🔁 Play again', game_menu:'☰ Modes', game_correct:'Correct!', game_check:'Check', game_type_ph:'Type what you hear…', game_replay:'Replay', game_speak_btn:'Speak', game_skip:'Skip',
      you_said:'You said', empty_heard:"Didn't catch that — try again.", mic_not_ready:'Mic not ready — reload the extension.',
    },
    de: {
      tab_practice:'Üben', tab_vocab:'Wörter', tab_flash:'Karten', tab_progress:'Fortschritt',
      nohost:'Öffne ein YouTube- oder Netflix-Video und komm hierher zurück.',
      ob_title:'Schnellstart', ob1:'Öffne ein deutsches Video auf YouTube.', ob2:'Untertitel laden automatisch nach ein paar Sekunden — nichts zu tun.', ob3:'Klicke „Mikro an" und erlaube den Mikrofonzugriff.', ob4:'Klicke einen Satz → sprich ihn nach → sieh deine Punktzahl.', ob_close:'Verstanden',
      status_init:'Öffne ein Video auf YouTube — Untertitel laden automatisch.',
      sec_settings:'Einstellungen', set_target:'Lernsprache', set_native:'Übersetzen nach', set_vsubs:'Untertitel im Video', set_uilang:'Oberflächensprache',
      at_mic:'Mikro an', at_dict:'Diktat', at_cloze:'Lücken', at_vocab:'Wortschatz', at_menu:'Menü',
      tt_mic:'Mikrofon erlauben, um die Aussprache zu bewerten', tt_dict:'Diktat: hören und den ganzen Satz tippen', tt_cloze:'Fehlende Wörter ergänzen', tt_vocab:'Gespeicherte & schwache Wörter', tt_menu:'Einstellungen öffnen', tt_loop:'Einen Satz wiederholen (Taste L)',
      bt_prev:'Zurück', bt_play:'Play', bt_pause:'Pause', bt_next:'Weiter', bt_loop:'Schleife',
      t_prev:'Vorheriger', t_play:'Play/Pause', t_loop:'Einen wiederholen', t_next:'Nächster', t_shadow:'Üben', t_listen:'Hören', t_dict:'Diktat', t_cloze:'Lücken füllen', t_blur:'Text verbergen (Selbsttest)',
      kbd_hint:'⌨ Leertaste: sprechen · ◀ ▶: Satz · ▲ ▼: Tempo · R: hören · L: Schleife · B: verbergen',
      tc_title:'Diesen Satz üben', tc_pause_on:'⏸ Auto-Pause: An', tc_pause_off:'▶ Auto-Pause: Aus', tc_pause_msg_on:'⏸ Auto-Pause nach jedem Satz: AN', tc_pause_msg_off:'▶ Auto-Pause nach jedem Satz: AUS', tc_next:'Weiter ›', tc_listen:'▷ Hören', tc_speak:'🎤 Sprechen & bewerten', tc_fav:'Diesen Satz favorisieren',
      rp_ready:'Bereit', rp_target:'Übung läuft', rp_match:'Übereinstimmung %', rp_yousaid:'DU SAGTEST',
      rp_listen:'🔊 Anhören', rp_replay:'🔁 Wiederholen', rescore_go:'🎤 Bewerten', rescore_stop:'⏹ Stopp & bewerten', wd_speak:'🔊 Richtige Aussprache hören',
      menu_title:'Menü', menu_logout:'Abmelden', usage_trans:'Übersetzungen heute', usage_ai:'KI heute', btn_upgrade:'⚡ Auf Pro upgraden',
      sec_vocab:'Wortschatz', sec_flash:'Lernkarten', voc_saved_title:'📚 Gespeicherte Wörter', voc_weak_title:'⚠️ Schwache Wörter', fc_hard:'Schwer', fc_good:'Gut', fc_skip:'Überspringen', flash_empty:'⭐ Füge Lieblingssätze hinzu, um Lernkarten zu üben!',
      pop_listen:'Hören', pop_save:'Speichern', pop_saved:'Gespeichert', pop_loading:'… wird übersetzt', pop_nomean:'(keine Übersetzung)', pop_pron:'Aussprache',
      voc_remove:'Entfernen', voc_empty:'Noch keine Wörter. Klicke ein Wort im Satz und ⭐ Speichern.', weak_empty:'Noch keine schwachen Wörter — übe weiter! 💪', weak_miss:'Falsch ausgesprochen',
      st_listening:'Hört zu…', st_transcribing:'Erkenne…', st_scoring:'Bewerte…', st_ready:'Bereit', st_playing:'Spielt…', st_paused:'Pausiert', st_ad:'Warte auf das Ende der Werbung…',
      stop:'⏹ Stopp', finalize:'✅ Fertig gesprochen → bewerten', fav_run:'▶️ ⭐-Sätze üben',
      empty_list:'Noch keine Untertitel. Öffne ein Video auf YouTube — sie laden automatisch.', pr_back:'← Zurück',
      set_master:'Extension aktivieren', ext_on:'Extension an', ext_off:'Extension aus',
      sent_saved:'⭐ Satz im Wortschatz gespeichert.', sent_unsaved:'Satz entfernt.', trans_unavailable:'🌐 Übersetzung nicht verfügbar — später erneut versuchen.',
      voc_tab_saved:'📚 Gespeichert', voc_tab_weak:'⚠️ Schwach', voc_total:'Wörter', voc_play_all:'▶ Alle abspielen', voc_review:'🎮 Üben',
      voc_def:'Definition', voc_example:'Beispiel', voc_notes:'Deine Notizen', voc_notes_ph:'Notiz hinzufügen…', voc_related:'Verwandte Wörter', voc_review_one:'🔁 Wiederholen', voc_forget:'🗑 Wort vergessen', close:'Schließen',
      game_title:'🎮 Wortschatz üben', game_empty:'Keine Wörter zum Üben — speichere zuerst Wörter.', game_flashcard:'Karten', game_choice:'Multiple Choice', game_type:'Hören & tippen', game_speak:'Sprechen & bewerten',
      game_pool:'Wortquelle', game_pool_sent:'Gespeicherte Sätze', game_reveal:'Aufdecken', game_done:'Fertig!', game_again:'🔁 Nochmal', game_menu:'☰ Modi', game_correct:'Richtig!', game_check:'Prüfen', game_type_ph:'Tippe, was du hörst…', game_replay:'Wiederholen', game_speak_btn:'Sprechen', game_skip:'Überspringen',
      you_said:'Du sagtest', empty_heard:'Nicht verstanden — versuch es nochmal.', mic_not_ready:'Mikro nicht bereit — Extension neu laden.',
    },
  };
  // Tra cứu chuỗi UI theo ngôn ngữ đang chọn (cho chuỗi động trong JS).
  function t(key, fallback) {
    const d = I18N[settings.uiLang] || I18N.vi;
    return (d && d[key]) || (I18N.vi && I18N.vi[key]) || (fallback != null ? fallback : key);
  }
  function setText(el, txt) {
    if (el.children.length === 0) { el.textContent = txt; return; }
    const n = el.firstChild;
    if (n && n.nodeType === 3) n.nodeValue = txt; else el.insertBefore(document.createTextNode(txt), el.firstChild);
  }
  function applyI18n(lang) {
    const d = I18N[lang] || I18N.vi;
    document.querySelectorAll('[data-i18n]').forEach((el) => { const k = el.dataset.i18n; if (d[k]) setText(el, d[k]); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { const k = el.dataset.i18nTitle; if (d[k]) el.title = d[k]; });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { const k = el.dataset.i18nPh; if (d[k]) el.placeholder = d[k]; });
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
  function startCloze(silent) {
    const s = sentences[current]; if (!s) { setStatus('Chưa có câu.', 'warn'); return; }
    activePanel = { type: 'cloze', diff: null, idx: current };
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
    $('#czclosesel').onclick = () => closeActivePanel();
    updatePracticeBlur();
    box.querySelectorAll('.dp-diff-btn').forEach((btn) => {
      btn.onclick = () => runCloze(s, btn.dataset.diff, box);
    });
  }

  function runCloze(s, difficulty, box, silent) {
    activePanel = { type: 'cloze', diff: difficulty, idx: current };
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
    if (!silent) speakText(s.text);
    updatePracticeBlur();
    const firstInp = box.querySelector('.cz'); if (firstInp) firstInp.focus();
    $('#czclose').onclick = () => closeActivePanel();
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
  function openMenu() { const m = $('#slide-menu'), o = $('#menu-overlay'); if (m) m.hidden = false; if (o) o.hidden = false; const sv = $('#section-vocab'); if (sv && sv.open) renderVocabView(); }
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
  { const b = $('#btn-prev'); if (b) b.onclick = () => { const rp = $('#record-panel'); if (rp && !rp.hidden) keepRecordPanel = true; manualSelectIdx = Math.max(0, current - 1); manualSelectUntil = Date.now() + 750; cmd('prev'); }; }
  { const b = $('#btn-next'); if (b) b.onclick = () => { const rp = $('#record-panel'); if (rp && !rp.hidden) keepRecordPanel = true; manualSelectIdx = Math.min(sentences.length - 1, current + 1); manualSelectUntil = Date.now() + 750; cmd('next'); }; }
  { const b = $('#btn-dictation'); if (b) b.onclick = () => startDictation(); }
  { const b = $('#btn-cloze'); if (b) b.onclick = () => startCloze(); }
  { const b = $('#btn-hint'); if (b) b.onclick = () => { const s = sentences[current]; if (s && s.trans) setStatus(s.trans, 'ok'); else if (s) translateText(s.text, settings.targetLang, settings.nativeLang).then((t) => { if (t) { s.trans = t; setStatus(t, 'ok'); } }); }; }
  // "Từ vựng": mở menu + mở mục Từ vựng (2 bảng: từ đã lưu + từ phát âm yếu).
  { const b = $('#btn-vocab'); if (b) b.onclick = () => { openMenu(); const sec = $('#section-vocab'); if (sec) { sec.open = true; renderVocabView(); sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }; }
  { const b = $('#btn-blur'); if (b) b.onclick = () => startRecall(); }
  // "Nghe mẫu": phát lại ĐÚNG đoạn video gốc của câu (giọng thật) thay vì TTS máy.
  { const b = $('#btn-listen'); if (b) b.onclick = () => { if (sentences[current]) cmd('listenSeg', { i: current }); }; }
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
  // (Đã bỏ nút "Lấy phụ đề"/"Bắt trực tiếp"/"Mở file" — phụ đề tự tải qua bridge.js.)

  // The "Luyện câu này" (ShadowEcho-style): Nghe (phát lại đúng đoạn video) / Nói & chấm / Câu sau
  // "Nghe" CHỈ phát lại đoạn video gốc của câu (không TTS chồng tiếng) — tránh xung đột âm.
  { const b = $('#try-card-listen'); if (b) b.onclick = () => { if (sentences[current]) cmd('listenSeg', { i: current }); }; }
  { const b = $('#try-card-speak'); if (b) b.onclick = () => { if (!sentences.length) return; openPractice(current); showRecordPanel(true); scoreNow(); }; }
  { const b = $('#try-card-next'); if (b) b.onclick = () => { if (current + 1 < sentences.length) selectRow(current + 1); }; }
  // Nút ⭐ trên thẻ "Luyện câu này" — thêm/bỏ yêu thích câu hiện tại.
  { const b = $('#try-fav-btn'); if (b) b.onclick = async () => {
      const s = sentences[current]; if (!s) return;
      b.classList.remove('fav-pop'); void b.offsetWidth; b.classList.add('fav-pop');
      const r = await cmd('fav', { text: s.text, trans: s.trans });
      if (r && r.favorites) favorites = r.favorites;
      updateTryCard();
      renderList();
      setStatus(isFav(s.text) ? t('sent_saved', '⭐ Đã lưu câu vào kho từ vựng.') : t('sent_unsaved', 'Đã bỏ câu khỏi kho.'), 'ok');
    }; }
  // Nut "Tu dung" tren the luyen tap — bat/tat tu dung cuoi moi cau (segPause).
  function updatePauseToggle() {
    const b = $('#try-pause-toggle'); if (!b) return;
    const on = settings.segPause !== false;
    b.classList.toggle('on', on);
    b.textContent = on ? t('tc_pause_on') : t('tc_pause_off');
  }
  { const b = $('#try-pause-toggle'); if (b) b.onclick = () => {
      settings.segPause = !(settings.segPause !== false);
      if ($('#segpause')) $('#segpause').checked = settings.segPause;
      cmd('settings', settings);
      updatePauseToggle();
      setStatus(settings.segPause ? t('tc_pause_msg_on', '⏸ Tự dừng cuối mỗi câu: BẬT') : t('tc_pause_msg_off', '▶ Tự dừng cuối mỗi câu: TẮT'), 'ok');
    }; }

  // Record panel
  // Hiện câu đang luyện trong panel "Nói & chấm" (image 7) — để vừa nghe vừa nói theo.
  function updateRecordTarget() {
    const wrap = $('#record-target'); if (!wrap) return;
    const s = sentences[current];
    if (!s) { wrap.hidden = true; return; }
    const de = $('#record-target-de'); if (de) de.textContent = s.text;
    const tr = $('#record-target-tr');
    if (tr) {
      tr.textContent = s.trans || '';
      tr.hidden = !s.trans;
      if (!s.trans && s.text) {
        translateText(s.text, settings.targetLang || 'de', settings.nativeLang || 'vi').then((t) => {
          if (t && sentences[current] === s) { s.trans = t; if ($('#record-target-de') && $('#record-target-de').textContent === s.text) { tr.textContent = t; tr.hidden = false; } }
        }).catch(() => {});
      }
    }
    wrap.hidden = false;
    // Hiệu ứng xuất hiện
    wrap.classList.remove('record-target--in'); void wrap.offsetWidth; wrap.classList.add('record-target--in');
  }
  function showRecordPanel(show) { const p = $('#record-panel'); if (p) { if (show) { syncToolbarHeight(); recordPanelIdx = current; updateRecordTarget(); } p.hidden = !show; } updatePracticeBlur(); }
  // Xoá kết quả chấm cũ → panel sẵn sàng cho câu mới khi điều hướng Trước/Sau trong lúc luyện.
  function resetRecordPanelScoreUI() {
    try { setRecordScore(null); } catch (_) {}
    { const el = $('#you-said-text'); if (el) el.textContent = ''; }
    { const tm = $('#score-tier-msg'); if (tm) tm.hidden = true; }
    { const pfe = $('#phoneme-focus'); if (pfe) pfe.hidden = true; }
    { const rb = $('#btn-replay'); if (rb) rb.disabled = true; }
    { const fb = $('#fb'); if (fb) fb.hidden = true; }
    { const ai = $('.ai-score'); if (ai) ai.hidden = true; }
    { const st = $('#record-status-text'); if (st) st.textContent = t('st_ready'); }
  }
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
    const st = $('#record-status-text'); if (st) st.textContent = on ? t('st_listening') : t('st_scoring');
    const b = $('#btn-rescore'); if (b) b.innerHTML = on ? t('rescore_stop', '⏹ Dừng &amp; chấm') : t('rescore_go', '🎤 Chấm điểm');
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
      if (res && res.error === 'aborted') { const st = $('#record-status-text'); if (st) st.textContent = t('st_ready'); return; }
      if (res && res.error === 'WHISPER_LOADING') {
        const st = $('#record-status-text'); if (st) st.textContent = t('st_ready');
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
        score = window.SD.phonetic.analyze(s.text, res.transcript, { lang: settings.targetLang || 'de', pitch: res.pitch || [], spokenMs: res.spokenMs, refMs: (s.endMs - s.startMs) });
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
  { const s = document.getElementById('section-vocab'); if (s) s.addEventListener('toggle', () => { if (s.open) renderVocabView(); }); }
  { const s = document.getElementById('section-flash'); if (s) s.addEventListener('toggle', () => { if (s.open) loadFlashCards(); }); }
  { const h = document.getElementById('btn-hard'); if (h) h.onclick = () => gradeFlash(0); }
  { const g = document.getElementById('btn-good'); if (g) g.onclick = () => gradeFlash(3); }
  { const sk = document.getElementById('btn-skip'); if (sk) sk.onclick = () => gradeFlash(5); }

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
      case 'KeyL': e.preventDefault(); cmd('loop').then((r) => { if (r) { const b = $('#btn-loop'); if (b) b.classList.toggle('on', !!r.loop); } }); break;
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
