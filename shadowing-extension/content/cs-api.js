/* cs-api.js — Cau noi giua content script (trang YouTube/Netflix) va Side Panel.
 * Side Panel gui lenh -> chay tren engine/speech/parsers; engine phat su kien -> day len Side Panel.
 *
 * Rebuild theo Trancy: Port-based communication voi reconnect logic.
 * - connect() tao chrome.runtime.connect({ name: 'content' })
 * - Nhan commands qua port.onMessage
 * - Gui events qua port.postMessage
 * - Reconnect tu dong khi port disconnect (SW restart) */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  const SD = root.SD;
  const E = () => SD.engine, S = () => SD.storage;
  let lastSentences = [];
  let port = null;
  let reconnectTimer = null;

  // --- Port management ---
  function send(evt, payload) {
    const msg = { sd: 'evt', evt, payload };
    // Try port first, fallback to sendMessage
    try {
      if (port) { port.postMessage(msg); return; }
    } catch (e) { port = null; }
    // Fallback: sendMessage (khi port chua san sang)
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  function status(text, kind) { send('status', { text, kind }); }

  function connectPort() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'content' });
      port.onMessage.addListener(handleCommand);
      port.onDisconnect.addListener(() => {
        port = null;
        // Auto-reconnect sau 1s (khi SW restart)
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectPort();
          }, 1000);
        }
      });
    } catch (e) {
      port = null;
      // Retry connect
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectPort();
        }, 2000);
      }
    }
  }

  // --- Command handler (nhan lenh tu Side Panel qua port hoac sendMessage) ---
  async function handleCommand(msg) {
    if (!msg || msg.sd !== 'cmd') return;
    const eng = E();
    const replyId = msg._replyId; // cho async reply qua port
    function reply(data) {
      if (replyId) {
        send('_reply', { _replyId: replyId, data });
      }
    }
    try {
      switch (msg.cmd) {
        case 'ping': reply({ ok: true, host: location.hostname }); break;
        case 'getState': {
          const d = await S().get();
          reply({
            ok: true, sentences: lastSentences,
            settings: d.settings, favorites: d.favorites,
            current: eng.current,
            tracks: SD.bridge ? SD.bridge.getAvailableTracks() : [],
          });
          break;
        }
        case 'loadAuto': {
          status('Đang lấy phụ đề tự động…');
          if (location.hostname.includes('youtube')) {
            const s = await SD.bridge.fetchYouTubeTrack(
              (msg.args && msg.args.target) || 'de',
              (msg.args && msg.args.native) || 'vi'
            );
            if (s && s.length) status('Đã tải ' + s.length + ' câu (YouTube).', 'ok');
            else status('Chưa bắt được track. Bật CC rồi bấm Live, hoặc kéo file SRT/VTT.', 'warn');
          } else {
            status('Netflix: bật phụ đề trên trình phát (sẽ tự bắt), hoặc nạp file SRT/VTT.', 'warn');
          }
          reply({ ok: true }); break;
        }
        case 'loadTrack': {
          // Load a specific subtitle track by language code
          if (msg.args && msg.args.langCode) {
            status('Đang tải track ' + msg.args.langCode + '…');
            const s = await SD.bridge.fetchYouTubeTrack(
              msg.args.langCode,
              (msg.args && msg.args.native) || 'vi'
            );
            if (s && s.length) status('Đã tải ' + s.length + ' câu.', 'ok');
            else status('Không tải được track này.', 'warn');
          }
          reply({ ok: true }); break;
        }
        case 'getTracks': {
          reply({ tracks: SD.bridge ? SD.bridge.getAvailableTracks() : [] });
          break;
        }
        case 'live': {
          if (!eng.live.running) {
            eng.live.start();
            status('Đang bắt phụ đề Live — để video chạy vài câu…');
            reply({ running: true });
          } else {
            const m = eng.live.stop();
            status('Đã bắt ' + m.length + ' câu (Live).', 'ok');
            reply({ running: false });
          }
          break;
        }
        case 'loadText': {
          const cues = SD.parsers.parseAuto(msg.args.text);
          const s = SD.parsers.mergeIntoSentences(cues);
          eng.setSentences(s);
          status('Đã nạp ' + s.length + ' câu.', 'ok');
          reply({ n: s.length }); break;
        }
        case 'select': eng.selectSegment(msg.args.i, { play: msg.args.play !== false }); reply({ ok: true }); break;
        case 'listenSeg': eng.listenSeg(msg.args && msg.args.i != null ? msg.args.i : eng.current); reply({ ok: true }); break;
        case 'togglePlay': eng.togglePlay(); reply({ ok: true }); break;
        case 'next': eng.nextSeg(); reply({ ok: true }); break;
        case 'prev': eng.prevSeg(); reply({ ok: true }); break;
        case 'loop': reply({ loop: eng.toggleLoop() }); break;
        case 'shadow':
          eng.shadowSingle(msg.args && msg.args.i != null ? msg.args.i : eng.current);
          reply({ ok: true }); break;
        case 'recordOnly':
          eng.recordOnlyAt(msg.args && msg.args.i != null ? msg.args.i : eng.current);
          reply({ ok: true }); break;
        case 'holdPause':
          // Side Panel ghi âm → giữ video DỪNG trong N ms để tiếng video không lẫn vào mic.
          eng.holdPause(msg.args && msg.args.ms);
          reply({ ok: true }); break;
        case 'releasePause':
          eng.releasePause();
          reply({ ok: true }); break;
        case 'stop':
          eng.stop();
          try { speechSynthesis.cancel(); } catch (e) {}
          reply({ ok: true }); break;
        case 'speak': {
          try {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(msg.args.text);
            u.lang = msg.args.lang || 'de-DE';
            u.rate = msg.args.rate || 1;
            speechSynthesis.speak(u);
          } catch (e) {}
          reply({ ok: true }); break;
        }
        case 'vsubs': {
          if (SD.videoSubs) SD.videoSubs.show(!!msg.args.on);
          reply({ ok: true }); break;
        }
        case 'extEnabled': {
          const on = !!(msg.args && msg.args.on);
          if (eng.setEnabled) eng.setEnabled(on);
          try { await S().saveSettings({ extEnabled: on }); } catch (e) {}
          if (SD.videoSubs && SD.videoSubs.setMaster) SD.videoSubs.setMaster(on);
          reply({ extEnabled: on }); break;
        }
        case 'diag': {
          let mic = 'unknown';
          try {
            if (navigator.permissions) {
              const pm = await navigator.permissions.query({ name: 'microphone' });
              mic = pm.state;
            }
          } catch (e) {}
          reply({
            ok: true, host: location.hostname,
            video: !!(SD.video && SD.video.isReady()),
            sentences: lastSentences.length,
            mic,
            engine: !!SD.engine,
            speech: !!SD.speech,
            vsubs: !!SD.videoSubs,
            tracklist: !!(SD.bridge && SD.bridge.hasTracklist && SD.bridge.hasTracklist()),
          });
          break;
        }
        case 'fav': {
          const f = await S().toggleFavorite(msg.args.text);
          reply({ favorites: f }); break;
        }
        case 'saveWord': {
          const w = await S().saveWord({ word: msg.args.word, context: msg.args.context });
          status('Đã lưu từ: ' + msg.args.word, 'ok');
          reply({ savedWords: w }); break;
        }
        case 'removeWord': {
          const w = await S().removeWord(msg.args.word);
          reply({ savedWords: w }); break;
        }
        case 'mic': {
          try {
            await SD.speech.ensureMic();
            status('✅ Đã bật micro.', 'ok');
            reply({ ok: true });
          } catch (e) {
            status('❌ Mic bị chặn (' + (e.name || e.message) + '). Bấm 🔒 cạnh thanh địa chỉ → Microphone → Allow.', 'warn');
            reply({ error: String(e.name || e.message) });
          }
          break;
        }
        case 'ensureMic': {
          // Cấp quyền micro NGAY trên trang YouTube (hộp thoại hiện tại trang, không mở tab).
          if (!SD.pageMic) { reply({ ok: false, onPage: false }); break; }
          try {
            await SD.pageMic.ensure();
            let state = 'granted'; try { state = await SD.pageMic.permission(); } catch (e) {}
            reply({ ok: true, onPage: true, state });
          } catch (e) {
            reply({ ok: false, onPage: true, error: String((e && (e.name || e.message)) || 'error'), state: 'denied' });
          }
          break;
        }
        case 'settings': {
          const st = await S().saveSettings(msg.args);
          eng.setSettings(st);
          reply({ settings: st }); break;
        }
        case 'vocab': {
          const d = await S().get();
          reply({ savedWords: d.savedWords, history: d.history }); break;
        }
        default: reply({ ok: false });
      }
    } catch (e) { try { reply({ error: String(e.message || e) }); } catch (_) {} }
  }

  function init() {
    const eng = E();
    eng.listen('sentences', (s) => { lastSentences = s; send('sentences', s); });
    eng.listen('current', (c) => send('current', c));
    eng.listen('playstate', (p) => send('playstate', p));
    eng.listen('loop', (l) => send('loop', l));
    eng.listen('state', (st) => send('state', st));
    eng.listen('feedback', (f) => send('feedback', f));
    if (SD.speech && SD.speech.setProgress) SD.speech.setProgress((st, pct) => send('progress', { status: st, pct }));
    eng.startHighlightLoop();

    // Connect port
    connectPort();

    try { console.info('[Shadow] content ready @', location.hostname); } catch (e) {}
  }

  // Fallback: van ho tro chrome.runtime.onMessage cho legacy compatibility
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.sd !== 'cmd') return;
    // Wrap reply cho async
    (async () => {
      const origReply = reply;
      msg._replyId = null; // khong can port reply
      // Create a wrapper that calls reply
      const replyWrap = (data) => { try { origReply(data); } catch (e) {} };
      // Temporarily replace reply mechanism
      const origSend = send;
      await handleCommand(msg);
    })();
    return true; // async reply
  });

  SD.csapi = { init, status };
})(window);
