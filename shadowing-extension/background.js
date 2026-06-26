/* background.js — Service Worker: Message Hub + Side Panel.
 * Pattern giong Trancy/asbplayer: Port-based relay giua Side Panel va Content Script.
 * Side Panel connect voi name "sidepanel", Content Script connect voi name "content".
 * Background relay messages giua chung theo tabId. */

/* --- Side Panel behavior --- */
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (e) {}
chrome.runtime.onInstalled.addListener((details) => {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}
  // Lần đầu cài extension -> đánh dấu để content script tự hiện hộp thoại xin quyền
  // micro NGAY trên trang YouTube/Netflix (origin của trang) ở lần mở đầu tiên.
  if (details && details.reason === 'install') {
    try { chrome.storage.local.set({ micOnboardPending: true }); } catch (e) {}
  }
});

/* --- Port Manager --- */
const ports = {
  sidepanel: null,       // port tu Side Panel (chi co 1)
  content: new Map(),    // tabId -> port tu Content Script
  spTabId: null,         // tabId ma Side Panel dang theo doi
};

function relayToSidePanel(msg) {
  try { if (ports.sidepanel) ports.sidepanel.postMessage(msg); } catch (e) {}
}
function relayToContent(tabId, msg) {
  const p = ports.content.get(tabId);
  try { if (p) p.postMessage(msg); } catch (e) {}
}

/* Khi Side Panel hoac Content Script connect */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    ports.sidepanel = port;
    // Side Panel gui message -> chuyen tiep sang Content Script cua tab dang active
    port.onMessage.addListener(async (msg) => {
      // Dac biet: Side Panel yeu cau doi tab
      if (msg._setTab) { ports.spTabId = msg._setTab; return; }
      // Relay sang content script
      const tabId = ports.spTabId || msg._tabId;
      if (tabId) relayToContent(tabId, msg);
    });
    port.onDisconnect.addListener(() => {
      ports.sidepanel = null;
    });
    return;
  }

  if (port.name === 'content') {
    // Content script gui tabId qua port.sender
    const tabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (!tabId) return;
    ports.content.set(tabId, port);
    // Content Script gui message -> chuyen tiep sang Side Panel
    port.onMessage.addListener((msg) => {
      // Danh dau tabId de Side Panel biet message tu tab nao
      msg._fromTab = tabId;
      relayToSidePanel(msg);
    });
    port.onDisconnect.addListener(() => {
      ports.content.delete(tabId);
    });
    return;
  }
});

/* --- Fallback: van ho tro sendMessage cho mic-service va legacy --- */
const WORKER_URL = 'https://nghienducchua-proxy.thoatran21012.workers.dev';

// Base64 (audio bytes) -> Blob -> POST /transcribe. CHẠY TRONG BACKGROUND SW vì
// content script trên YouTube bị CSP (connect-src) của trang CHẶN fetch tới domain
// lạ. Background SW có host_permissions + KHÔNG bị page CSP → luôn gọi được Groq.
async function handleGroqTranscribe(msg) {
  try {
    const bin = atob(msg.audioB64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = msg.mime || 'audio/webm';
    const blob = new Blob([bytes], { type: mime });
    const form = new FormData();
    const ext = mime.includes('ogg') ? 'ogg' : 'webm';
    form.append('file', blob, 'recording.' + ext);
    form.append('lang', msg.lang || 'de');
    const resp = await Promise.race([
      fetch(WORKER_URL + '/transcribe', { method: 'POST', body: form }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('groq-timeout')), 10000)),
    ]);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const errCode = (data && data.error) || ('http-' + resp.status);
      return { ok: false, _err: errCode };
    }
    if (data && data.error) return { ok: false, _err: 'groq-api:' + data.error };
    return { ok: true, data };
  } catch (e) { return { ok: false, _err: (e && e.message) || 'groq-error' }; }
}

/* --- Dịch phụ đề kép trên video (Language Reactor style) ---
 * Content script trên YouTube bị page-CSP chặn fetch sang domain dịch. Background SW
 * có host_permissions nên gọi được. Ưu tiên: Microsoft -> Google -> MyMemory.
 * (YouTube tlang đã được gán lúc fetch phụ đề; đây chỉ là dự phòng khi thiếu bản dịch.) */
let _bgMsTok = null, _bgMsTokAt = 0;
async function bgMsToken(force) {
  if (force || !_bgMsTok || Date.now() - _bgMsTokAt > 9 * 60 * 1000) {
    const r = await fetch('https://edge.microsoft.com/translate/auth');
    if (!r.ok) throw new Error('ms-auth-' + r.status);
    const t = (await r.text()).trim();
    if (!t) throw new Error('ms-auth-empty');
    _bgMsTok = t; _bgMsTokAt = Date.now();
  }
  return _bgMsTok;
}
async function bgMicrosoftTranslate(text, from, to) {
  const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=' +
    encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to);
  const doFetch = async (tok) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
    body: JSON.stringify([{ Text: text }]),
  });
  let r = await doFetch(await bgMsToken(false));
  if (r.status === 401) { _bgMsTok = null; r = await doFetch(await bgMsToken(true)); }
  if (!r.ok) throw new Error('ms-' + r.status);
  const j = await r.json();
  return ((j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text) || '').trim();
}
async function bgGoogleTranslate(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
    encodeURIComponent(from || 'auto') + '&tl=' + encodeURIComponent(to) + '&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) throw new Error('g-' + r.status);
  const j = await r.json();
  if (!j || !Array.isArray(j[0])) return '';
  return j[0].map((seg) => (seg && seg[0]) || '').join('').trim();
}
async function bgMyMemoryTranslate(text, from, to) {
  const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + from + '|' + to);
  const j = await r.json();
  return (j && j.responseData && j.responseData.translatedText) || '';
}
// ── Phân tầng dịch theo GÓI ──────────────────────────────────
// User TRẢ PHÍ → dịch qua Worker /translate (provider do Admin chọn: Gemini/DeepL/…).
// User FREE/chưa đăng nhập → dịch miễn phí (Microsoft → Google → MyMemory) như cũ.
// Worker tự quyết định free/paid; ở đây cache kết quả để khỏi gọi Worker mỗi câu khi free.
async function bgSessionToken() {
  try { const r = await chrome.storage.local.get('shadowecho_session'); return (r && r.shadowecho_session && r.shadowecho_session.access_token) || ''; } catch (_) { return ''; }
}
// trạng thái tầng dịch: 'premium' | 'free' | 'fallback' | 'unknown'
let _transTier = { state: 'unknown', at: 0 };
const _TIER_TTL = { free: 5 * 60 * 1000, fallback: 60 * 1000 };
async function bgWorkerTranslate(token, text, from, to) {
  const r = await fetch(WORKER_URL + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ text, from, to }),
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, data };
}
async function bgFreeTranslate(text, from, to) {
  try { const t = await bgMicrosoftTranslate(text, from, to); if (t) return { ok: true, text: t, src: 'ms' }; } catch (e) {}
  try { const t = await bgGoogleTranslate(text, from, to); if (t) return { ok: true, text: t, src: 'google' }; } catch (e) {}
  try { const t = await bgMyMemoryTranslate(text, from, to); if (t) return { ok: true, text: t, src: 'mymemory' }; } catch (e) {}
  return { ok: false };
}
async function handleTranslate(msg) {
  const text = (msg && msg.text) || '';
  const from = (msg && msg.from) || 'de';
  const to = (msg && msg.to) || 'vi';
  if (!text) return { ok: false };

  const token = await bgSessionToken();
  const now = Date.now();
  // Có thử Worker không? Bỏ qua khi vừa xác định là free/fallback (còn hạn cache).
  let tryWorker = !!token;
  if (token && _transTier.state === 'free' && now - _transTier.at < _TIER_TTL.free) tryWorker = false;
  if (token && _transTier.state === 'fallback' && now - _transTier.at < _TIER_TTL.fallback) tryWorker = false;

  if (tryWorker) {
    try {
      const res = await bgWorkerTranslate(token, text, from, to);
      if (res.ok && res.data) {
        if (res.data.text && !res.data.free) {
          _transTier = { state: 'premium', at: now };
          return { ok: true, text: res.data.text, src: res.data.src || res.data.provider || 'api' };
        }
        if (res.data.free) {
          // provider==='free' → user free thật; có error → tạm lỗi (cache ngắn rồi thử lại).
          _transTier = { state: res.data.provider === 'free' && !res.data.error ? 'free' : 'fallback', at: now };
        }
      } else if (res.status === 401) {
        _transTier = { state: 'fallback', at: now }; // token hết hạn → dùng free tạm
      }
    } catch (_) { /* lỗi mạng → rơi xuống free */ }
  }
  return bgFreeTranslate(text, from, to);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Groq STT relay (content script -> background -> Worker). Async reply.
  if (msg && msg.sd === 'groq-transcribe') {
    handleGroqTranscribe(msg).then(reply).catch((e) => reply({ ok: false, _err: String((e && e.message) || e) }));
    return true;
  }
  // Dịch phụ đề kép cho overlay trên video. Async reply.
  if (msg && msg.sd === 'translate') {
    handleTranslate(msg).then(reply).catch(() => reply({ ok: false }));
    return true;
  }
  // Mở Side Panel khi bấm logo trong trình phát YouTube (Language Reactor style).
  // Phải gọi trong user gesture — click → content script → sendMessage → đây.
  if (msg && msg.sd === 'openSidePanel') {
    (async () => {
      try {
        const tabId = sender && sender.tab && sender.tab.id;
        const windowId = sender && sender.tab && sender.tab.windowId;
        if (tabId != null) { ports.spTabId = tabId; }
        if (chrome.sidePanel && chrome.sidePanel.open) {
          if (windowId != null) await chrome.sidePanel.open({ windowId });
          else if (tabId != null) await chrome.sidePanel.open({ tabId });
        }
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  // Worker health check qua background (dùng cho self-test). Async reply.
  if (msg && msg.sd === 'worker-health') {
    (async () => {
      try {
        const t0 = Date.now();
        const r = await fetch(WORKER_URL + '/health');
        let body = ''; try { body = JSON.stringify(await r.json()); } catch (_) {}
        reply({ ok: r.ok, detail: 'HTTP ' + r.status + (body ? ' ' + body.slice(0, 90) : ''), ms: Date.now() - t0 });
      } catch (e) { reply({ ok: false, err: 'fetch failed: ' + ((e && e.message) || e) }); }
    })();
    return true;
  }
  // Mic-service messages: relay truc tiep (chi can Side Panel gui/nhan)
  if (msg && msg.sd === 'mic-service') return; // xu ly boi mic-service.js trong Side Panel
  // Legacy evt messages tu content script (neu chua chuyen sang port)
  if (msg && msg.sd === 'evt') {
    relayToSidePanel(msg);
    return;
  }
});

/* --- Tab tracking: cap nhat spTabId khi user chuyen tab --- */
chrome.tabs.onActivated.addListener((info) => {
  ports.spTabId = info.tabId;
  relayToSidePanel({ _tabChanged: info.tabId });
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && tabId === ports.spTabId) {
    relayToSidePanel({ _tabUpdated: tabId });
  }
});
