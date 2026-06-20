/* ISOLATED world. Nhan su kien SD_SUBS_CAPTURED tu interceptor (MAIN world),
 * parse, gop cau, va goi callback dang ky boi shadow-engine/overlay.
 *
 * Cai tien theo Trancy/asbplayer:
 * - SPA navigation watcher (URL polling + navigation events)
 * - Auto-retry fetchYouTubeTrack khi tracklist chua san sang
 * - Cache videoId hien tai, chi reload subs khi videoId doi
 * - Emit navigation events cho engine */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  const listeners = [];
  let lastTracklist = null;
  let currentVideoId = '';
  let pendingFetch = null; // { resolve, timer } cho fetchYouTubeTrack qua MAIN world
  function clearPending() { if (pendingFetch) { try { clearTimeout(pendingFetch.timer); } catch (e) {} pendingFetch = null; } }

  function onSubtitles(cb) { listeners.push(cb); }
  function emitSentences(sentences, meta) {
    try { console.info('[Shadow] subtitles:', sentences.length, (meta && meta.source) || ''); } catch (e) {}
    listeners.forEach((cb) => { try { cb(sentences, meta); } catch (e) {} });
  }

  document.addEventListener('SD_SUBS_CAPTURED', (ev) => {
    const d = ev.detail || {};
    const P = root.SD.parsers;
    if (!P) return;

    // SPA navigation event → reset
    if (d.format === 'navigate') {
      if (d.videoId && d.videoId !== currentVideoId) {
        currentVideoId = d.videoId;
        lastTracklist = null;
        // Thong bao engine reset
        listeners.forEach((cb) => { try { cb([], { source: d.source, navigate: true }); } catch (e) {} });
      }
      return;
    }

    // Tracklist tu YouTube
    if (d.format === 'tracklist') {
      lastTracklist = d.data;
      if (d.videoId) currentVideoId = d.videoId;
      return;
    }

    // Phu de da fetch xong (co POT) tu MAIN world -> parse + gan ban dich
    if (d.format === 'yt-captions') {
      const cues = P.parseJson3(d.data);
      if (cues && cues.length) {
        const sentences = P.mergeIntoSentences(cues);
        if (d.transData) {
          try { const tcues = P.parseJson3(d.transData); if (tcues.length) attachTrans(sentences, tcues); } catch (e) {}
        }
        emitSentences(sentences, { source: 'youtube', auto: true });
        if (pendingFetch) { const r = pendingFetch.resolve; clearPending(); r(sentences); }
      } else if (pendingFetch) {
        const r = pendingFetch.resolve; clearPending(); r(null);
      }
      return;
    }
    if (d.format === 'yt-error') {
      if (pendingFetch) { const r = pendingFetch.resolve; clearPending(); r(null); }
      return;
    }

    // Netflix DOM live capture (tu DOM fallback)
    if (d.format === 'dom-live') {
      // Gui text truc tiep cho live capture engine
      if (root.SD.engine && root.SD.engine.live && root.SD.engine.live.running) {
        root.SD.engine.live.addDomCue(d.data);
      }
      return;
    }

    // Parse subtitle data
    let cues = [];
    if (d.format === 'json3') { cues = P.parseJson3(d.data); if (!cues.length) cues = P.parseAuto(d.data); }
    else if (d.format === 'vtt') cues = P.parseVTT(d.data);
    else if (d.format === 'ttml') cues = P.parseTTML(d.data);
    else cues = P.parseAuto(d.data);
    if (cues && cues.length) {
      const sentences = P.mergeIntoSentences(cues);
      emitSentences(sentences, { source: d.source, auto: true });
    }
  });

  // Tai phu de tu tracklist YouTube (fmt=json3) khi nguoi dung bam "Phu de tu dong"
  function attachTrans(sentences, tcues) {
    for (const s of sentences) {
      const parts = tcues.filter((c) => c.startMs < s.endMs && c.endMs > s.startMs).map((c) => c.text);
      if (parts.length) s.trans = parts.join(' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Yeu cau MAIN world (intercept-youtube.js) fetch phu de co POT token roi tra ket qua.
  function fetchYouTubeTrack(langPref, nativeLang) {
    return new Promise((resolve) => {
      // Huy yeu cau cu neu con treo
      if (pendingFetch) { const old = pendingFetch.resolve; clearPending(); try { old(null); } catch (e) {} }
      const timer = setTimeout(() => {
        clearPending();
        // Du phong: thu cach cu (truc tiep, khong POT) — co the van chay voi video cu
        legacyFetchYouTubeTrack(langPref, nativeLang).then(resolve);
      }, 14000);
      pendingFetch = { resolve, timer };
      try {
        document.dispatchEvent(new CustomEvent('SD_FETCH_YT_TRACK', { detail: { langPref: langPref || 'de', nativeLang: nativeLang || '' } }));
      } catch (e) { clearPending(); legacyFetchYouTubeTrack(langPref, nativeLang).then(resolve); }
    });
  }

  // Du phong: cach cu (fetch truc tiep tu ISOLATED, KHONG co POT — co the that bai tren
  // YouTube moi, nhung van huu ich khi POT khong bat duoc hoac video cu).
  async function legacyFetchYouTubeTrack(langPref, nativeLang) {
    if (!lastTracklist || !lastTracklist.length) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (lastTracklist && lastTracklist.length) break;
      }
    }
    if (!lastTracklist || !lastTracklist.length) return null;

    let track = lastTracklist.find((t) => (t.languageCode || '').startsWith(langPref || 'de'));
    if (!track) track = lastTracklist[0];
    const base = track.baseUrl.replace(/&fmt=\w+/, '');
    try {
      const txt = await (await fetch(base + '&fmt=json3')).text();
      const cues = root.SD.parsers.parseJson3(txt);
      if (!cues.length) return null;
      const sentences = root.SD.parsers.mergeIntoSentences(cues);
      if (nativeLang && nativeLang !== (track.languageCode || '').slice(0, 2)) {
        try {
          const ttxt = await (await fetch(base + '&fmt=json3&tlang=' + nativeLang)).text();
          const tcues = root.SD.parsers.parseJson3(ttxt);
          if (tcues.length) attachTrans(sentences, tcues);
        } catch (e) {}
      }
      emitSentences(sentences, { source: 'youtube', auto: true });
      return sentences;
    } catch (e) {}
    return null;
  }

  // Tra ve danh sach track co san (cho Side Panel hien thi dropdown)
  function getAvailableTracks() {
    if (!lastTracklist || !lastTracklist.length) return [];
    return lastTracklist.map((t) => ({
      languageCode: t.languageCode || '',
      name: (t.name && t.name.simpleText) || t.languageCode || 'Unknown',
      isAutoGenerated: !!(t.kind && t.kind === 'asr'),
      baseUrl: t.baseUrl,
    }));
  }

  // --- SPA Navigation Watcher (backup cho truong hop event khong fire) ---
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Emit navigation cho engine
      const vid = new URL(location.href).searchParams.get('v') || location.pathname;
      if (vid !== currentVideoId) {
        currentVideoId = vid;
        lastTracklist = null;
        listeners.forEach((cb) => { try { cb([], { source: 'navigation', navigate: true }); } catch (e) {} });
      }
    }
  }, 500);

  root.SD.bridge = { onSubtitles, emitSentences, fetchYouTubeTrack, getAvailableTracks, hasTracklist: () => !!lastTracklist };
})(window);
