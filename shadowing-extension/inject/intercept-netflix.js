/* MAIN world. Bat phu de Netflix (TTML/DFXP hoac WebVTT) qua hijack fetch/XHR.
 * Netflix tai phu de tu *.nflxvideo.net voi "?o=..."; ta nhan dien theo noi dung.
 *
 * Cai tien theo asbplayer:
 * - DOM fallback: MutationObserver tren .player-timedtext container
 * - URL-specific check cho nflxvideo.net
 * - Netflix SPA navigation detection */
(function () {
  'use strict';
  if (window.__SD_NF_HOOKED__) return; window.__SD_NF_HOOKED__ = true;

  function emit(detail) {
    try { document.dispatchEvent(new CustomEvent('SD_SUBS_CAPTURED', { detail })); } catch (e) {}
  }
  function looksLikeSubs(txt) {
    if (!txt || txt.length < 20) return false;
    return /<tt[\s>]/i.test(txt) || /^WEBVTT/.test(txt.trimStart()) || /<\/p>/i.test(txt);
  }
  function maybeEmit(url, txt) {
    if (looksLikeSubs(txt)) {
      const fmt = /^WEBVTT/.test(txt.trimStart()) ? 'vtt' : 'ttml';
      emit({ source: 'netflix', format: fmt, data: txt, url });
    }
  }

  // --- Network interception: fetch ---
  const origFetch = window.fetch;
  window.fetch = async function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await origFetch.apply(this, arguments);
    try {
      // Netflix-specific URL patterns + generic subtitle patterns
      const shouldCheck = /nflxvideo\.net/i.test(url) ||
        /\?o=|timedtext|\.dfxp|\.ttml|\.vtt/i.test(url);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (shouldCheck || /xml|vtt|text|octet-stream/.test(ct)) {
        res.clone().text().then((t) => maybeEmit(url, t)).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // --- Network interception: XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__sd_url = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try { if (typeof this.responseText === 'string') maybeEmit(this.__sd_url || '', this.responseText); } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // --- DOM Fallback: bat phu de khi network interception that bai ---
  // Netflix render phu de vao DOM (.player-timedtext), ta observe thay doi
  let domFallbackActive = false;
  let lastDomText = '';
  function startDomFallback() {
    if (domFallbackActive) return;
    domFallbackActive = true;
    const observer = new MutationObserver(() => {
      try {
        const container = document.querySelector('.player-timedtext-text-container') ||
          document.querySelector('.player-timedtext');
        if (!container) return;
        const txt = container.innerText.trim();
        if (txt && txt !== lastDomText && txt.length > 2) {
          lastDomText = txt;
          emit({ source: 'netflix', format: 'dom-live', data: txt });
        }
      } catch (e) {}
    });
    // Observe body vi Netflix thay doi DOM lien tuc
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  // Bat DOM fallback sau 5s (du thoi gian cho network intercept hoat dong truoc)
  setTimeout(startDomFallback, 5000);

  // --- Netflix SPA navigation ---
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastDomText = '';
      emit({ source: 'netflix', format: 'navigate', videoId: location.pathname });
    }
  }, 800);
})();
