/* MAIN world. Lay phu de YouTube theo ky thuat ShadowEcho/asbplayer + xu ly POT token.
 *
 * YouTube 2025-2026 bat buoc POT (Proof-of-Origin) token cho /api/timedtext:
 * thieu &pot= -> server tra ve rong/403. Vi vay KHONG the fetch tu ISOLATED world.
 * File nay chay o MAIN world nen:
 *   1) Bat POT token tu cac request timedtext that (fetch + XHR hook).
 *   2) Doc tracklist truc tiep tu player.getPlayerResponse() (luon moi sau SPA nav).
 *   3) Ep YouTube tao token bang cach bam nut CC (.ytp-subtitles-button).
 *   4) Fetch json3 voi &pot=...&c=WEB&lang=... (credentials:include) ngay tai MAIN world.
 *   5) Gui ket qua sang content script (ISOLATED) qua CustomEvent SD_SUBS_CAPTURED.
 *
 * Van giu intercept thu dong (passive) lam du phong: neu YouTube tu fetch timedtext
 * (khi user bat CC) thi bat luon van ban do — duong nay khong can POT. */
(function () {
  'use strict';
  if (window.__SD_YT_HOOKED__) return; window.__SD_YT_HOOKED__ = true;

  function emit(detail) {
    try { document.dispatchEvent(new CustomEvent('SD_SUBS_CAPTURED', { detail })); } catch (e) {}
  }
  function isTimedText(url) { return typeof url === 'string' && url.indexOf('/api/timedtext') !== -1; }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'live') && parts[1]) return parts[1];
      return '';
    } catch (e) { return ''; }
  }

  // --- POT token cache (videoId -> pot) -------------------------------------
  const potCache = new Map();
  function extractPot(url) {
    try {
      if (url && url.indexOf('timedtext') !== -1 && url.indexOf('pot=') !== -1) {
        const m = url.match(/[?&]pot=([^&]+)/);
        const vm = url.match(/[?&]v=([^&]+)/);
        if (m && m[1]) {
          const vid = vm ? decodeURIComponent(vm[1]) : getVideoId();
          if (vid) potCache.set(vid, m[1]); // giu nguyen encoding cua URL goc
        }
      }
    } catch (e) {}
  }

  // --- fetch hook: bat POT + bat van ban timedtext thu dong -----------------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    extractPot(url);
    const ret = origFetch.apply(this, arguments);
    try {
      if (isTimedText(url)) {
        ret.then((res) => {
          res.clone().text().then((txt) => {
            if (txt) emit({ source: 'youtube', format: 'json3', data: txt, url, videoId: getVideoId() });
          }).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) {}
    return ret;
  };

  // --- XHR hook -------------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sd_url = url;
    extractPot(url ? url.toString() : '');
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (isTimedText(this.__sd_url) && this.responseText) {
          emit({ source: 'youtube', format: 'json3', data: this.responseText, url: this.__sd_url, videoId: getVideoId() });
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // --- Tracklist: getPlayerResponse() (live) hoac ytInitialPlayerResponse ----
  function getPlayerResponse() {
    try {
      const p = document.querySelector('.html5-video-player') || document.getElementById('movie_player');
      if (p && typeof p.getPlayerResponse === 'function') { const pr = p.getPlayerResponse(); if (pr) return pr; }
    } catch (e) {}
    return window.ytInitialPlayerResponse || null;
  }
  function getTracks() {
    const pr = getPlayerResponse();
    const c = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    return (c && c.captionTracks) || null;
  }

  let lastVideoId = '';
  function exposeTracks() {
    const tracks = getTracks(); const vid = getVideoId();
    if (tracks && tracks.length) {
      // Extract any POT already embedded in track URLs — avoids needing CC button click
      for (const t of tracks) {
        if (t.baseUrl) extractPot(t.baseUrl + (t.baseUrl.indexOf('v=') < 0 ? '&v=' + vid : ''));
      }
      emit({ source: 'youtube', format: 'tracklist', data: tracks, videoId: vid });
      lastVideoId = vid;
    }
  }
  function exposeWithRetry() { [0, 300, 700, 1500, 3000, 5000].forEach((d) => setTimeout(exposeTracks, d)); }
  exposeWithRetry();

  // ISOLATED world can ask for tracklist at any time (e.g. after bridge.js is ready)
  document.addEventListener('SD_REQUEST_TRACKLIST', exposeWithRetry);

  // --- Ep YouTube tao mot request timedtext de bat POT ----------------------
  async function forceCaptionRequest() {
    try {
      const btn = document.querySelector('.ytp-subtitles-button') ||
                  document.querySelector('button[aria-label*="ubtitle"]') ||
                  document.querySelector('button[aria-label*="aption"]') ||
                  document.querySelector('.ytp-button[title*="ubtitle"]');
      if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 220)); btn.click(); }
    } catch (e) {}
  }
  async function ensurePot(videoId) {
    if (potCache.has(videoId)) return potCache.get(videoId);
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      if (potCache.has(videoId)) return potCache.get(videoId);
      await forceCaptionRequest();
      await new Promise((r) => setTimeout(r, 800));
    }
    return potCache.get(videoId) || null;
  }

  function pickTrack(tracks, pref) {
    if (!tracks || !tracks.length) return null;
    let t = null;
    if (pref) {
      t = tracks.find((x) => x.languageCode === pref) ||
          tracks.find((x) => x.languageCode && x.languageCode.startsWith(pref.split('-')[0]));
    }
    if (!t) t = tracks.find((x) => x.languageCode === 'de') || tracks.find((x) => x.languageCode && x.languageCode.startsWith('de'));
    if (!t) t = tracks.find((x) => x.languageCode === 'en') || tracks.find((x) => x.languageCode && x.languageCode.startsWith('en'));
    if (!t) t = tracks.find((x) => x.kind === 'asr') || tracks[0];
    return (t && t.baseUrl) ? t : null;
  }

  // --- Fetch phu de chinh thuc khi user bam "Phu de tu dong" --------
  async function fetchCaptions(langPref, nativeLang) {
    const vid = getVideoId();
    let tracks = getTracks(); const t0 = Date.now();
    while ((!tracks || !tracks.length) && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 250)); tracks = getTracks();
    }
    if (!tracks || !tracks.length) { emit({ source: 'youtube', format: 'yt-error', reason: 'no-tracks', videoId: vid }); return; }
    const track = pickTrack(tracks, langPref);
    if (!track) { emit({ source: 'youtube', format: 'yt-error', reason: 'no-track', videoId: vid }); return; }

    // Reuse POT already embedded in baseUrl (YouTube 2025 puts it there).
    // Only strip fmt/tlang/lang — keep pot= if present.
    const baseWithMaybePot = track.baseUrl
      .replace(/&fmt=\w+/g, '').replace(/&tlang=[^&]*/g, '').replace(/&lang=[^&]*/g, '');
    const existingPot = baseWithMaybePot.match(/[?&]pot=([^&]+)/);
    let pot = existingPot ? existingPot[1] : null;
    if (pot && vid) potCache.set(vid, pot); // warm cache

    const base = baseWithMaybePot.replace(/&pot=[^&]*/g, ''); // clean URL for adding pot back
    if (!pot) pot = await ensurePot(vid); // fall back to CC-click approach

    const potParam = pot ? ('&pot=' + pot) : '';
    const url = base + '&fmt=json3' + potParam + '&c=WEB&lang=' + encodeURIComponent(track.languageCode || langPref || 'de');

    // Also try without pot as last resort (some videos/accounts may not need it)
    const urlNoPot = base + '&fmt=json3&c=WEB&lang=' + encodeURIComponent(track.languageCode || langPref || 'de');

    for (const fetchUrl of [url, urlNoPot]) {
      if (fetchUrl === urlNoPot && pot) continue; // skip no-pot if we have pot (already tried that)
      try {
        const r = await origFetch.call(window, fetchUrl, { credentials: 'include' });
        const data = await r.text();
        if (!data) continue;
        try { const parsed = JSON.parse(data); if (!parsed || !parsed.events || !parsed.events.length) continue; } catch(e) { continue; }
        let transData = null;
        const nl = (nativeLang || '').slice(0, 2);
        if (nl && nl !== (track.languageCode || '').slice(0, 2)) {
          try {
            const r2 = await origFetch.call(window, fetchUrl + '&tlang=' + encodeURIComponent(nl), { credentials: 'include' });
            transData = await r2.text();
          } catch (e) {}
        }
        emit({ source: 'youtube', format: 'yt-captions', data, transData, langCode: track.languageCode, videoId: vid });
        return;
      } catch (e) {}
    }
    emit({ source: 'youtube', format: 'yt-error', reason: 'fetch-failed', videoId: vid });
  }

  // Nhan yeu cau tu content script (ISOLATED)
  document.addEventListener('SD_FETCH_YT_TRACK', (ev) => {
    const d = (ev && ev.detail) || {};
    fetchCaptions(d.langPref || 'de', d.nativeLang || '');
  });

  // --- SPA Navigation -------------------------------------------------------
  function onNavigate() {
    const vid = getVideoId();
    if (vid && vid !== lastVideoId) {
      emit({ source: 'youtube', format: 'navigate', videoId: vid });
      lastVideoId = vid;
      exposeWithRetry();
    }
  }
  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-page-data-updated', onNavigate);
  window.addEventListener('popstate', () => setTimeout(onNavigate, 300));
  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; onNavigate(); } }, 800);
})();
