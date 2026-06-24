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

  // --- Tu dong tai phu de (khong con nut "Lay phu de") -----------------------
  // Khi bat duoc tracklist cho 1 video, tu dong fetch phu de mot lan theo ngon ngu
  // dang hoc trong Settings. Reset khi chuyen video (SPA navigation).
  let autoLoadedFor = '';
  let autoLoadTimer = null;
  function scheduleAutoLoad() {
    if (autoLoadTimer) return;
    autoLoadTimer = setTimeout(() => { autoLoadTimer = null; maybeAutoLoad(); }, 600);
  }
  function maybeAutoLoad() {
    try {
      if (!location.hostname.includes('youtube')) return;
      const vid = currentVideoId || '';
      if (vid && autoLoadedFor === vid) return;
      if (!lastTracklist || !lastTracklist.length) return;
      const st = (root.SD.engine && root.SD.engine.settings) || {};
      const target = st.targetLang || 'de';
      const native = st.nativeLang || 'vi';
      autoLoadedFor = vid;
      fetchYouTubeTrack(target, native).then((s) => {
        if (!s || !s.length) autoLoadedFor = ''; // that bai -> cho thu lai lan toi
      }).catch(() => { autoLoadedFor = ''; });
    } catch (e) {}
  }

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
        autoLoadedFor = ''; // cho phep tu tai lai phu de cho video moi
        // Thong bao engine reset
        listeners.forEach((cb) => { try { cb([], { source: d.source, navigate: true }); } catch (e) {} });
      }
      return;
    }

    // Tracklist tu YouTube
    if (d.format === 'tracklist') {
      lastTracklist = d.data;
      if (d.videoId) currentVideoId = d.videoId;
      scheduleAutoLoad(); // tu dong tai phu de ngay khi co tracklist
      return;
    }

    // Phu de da fetch xong (co POT) tu MAIN world -> parse + gan ban dich.
    // KHONG emit o day — ben dieu phoi (fetchYouTubeTrack) emit ket qua ve dich truoc.
    if (d.format === 'yt-captions') {
      let sentences = null;
      const cues = P.parseJson3(d.data);
      if (cues && cues.length) {
        sentences = P.mergeIntoSentences(cues);
        if (d.transData) {
          try { const tcues = P.parseJson3(d.transData); if (tcues.length) attachTrans(sentences, tcues); } catch (e) {}
        }
      }
      if (pendingFetch) { const r = pendingFetch.resolve; clearPending(); r(sentences && sentences.length ? sentences : null); }
      else if (sentences && sentences.length) emitSentences(sentences, { source: 'youtube', auto: true }); // den muon -> van hien
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
  // Gán bản dịch theo ĐIỂM GIỮA (logic dùng chung ở parsers.js, có unit test).
  function attachTrans(sentences, tcues) {
    const P = root.SD && root.SD.parsers;
    if (P && P.attachTranslations) return P.attachTranslations(sentences, tcues);
  }

  // Lay phu de YouTube — CHAY SONG SONG 2 duong, lay duong nao xong TRUOC:
  //  (1) NHANH: fetch truc tiep tu tracklist co san (same-origin, KHONG can POT) —
  //      giong cach ban cu, gan nhu tuc thi khi tracklist da bat duoc.
  //  (2) CHAC CHAN: nho MAIN world fetch co POT (cho video chan tai phu de).
  // Duong nao tra ve cau hop le truoc thi dung; emit MOT LAN tai day.
  function fetchYouTubeTrack(langPref, nativeLang) {
    // Nhac MAIN world xuat lai tracklist NGAY -> duong nhanh co tracklist som nhat.
    try { document.dispatchEvent(new CustomEvent('SD_REQUEST_TRACKLIST')); } catch (e) {}
    return new Promise((resolve) => {
      let settled = false, hardTimer = null;
      const done = (sentences) => {
        if (settled || !sentences || !sentences.length) return;
        settled = true;
        try { clearTimeout(hardTimer); } catch (e) {}
        emitSentences(sentences, { source: 'youtube', auto: true });
        resolve(sentences);
      };
      // (1) Duong nhanh — phu de co san (cho toi da 3.5s neu tracklist chua bat duoc).
      legacyFetchYouTubeTrack(langPref, nativeLang, { silent: true, maxWaitMs: 3500 })
        .then(done).catch(() => {});
      // (2) Duong chac chan — co POT (du phong khi duong nhanh tra rong).
      requestPotFetch(langPref, nativeLang).then(done).catch(() => {});
      // Ca 2 deu that bai trong han -> tra null de UI bao.
      hardTimer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 15000);
    });
  }

  // Nho MAIN world (intercept-youtube.js) fetch co POT, tra ve Promise<sentences|null>.
  function requestPotFetch(langPref, nativeLang) {
    return new Promise((resolve) => {
      if (pendingFetch) { const old = pendingFetch.resolve; clearPending(); try { old(null); } catch (e) {} }
      const timer = setTimeout(() => { clearPending(); resolve(null); }, 14000);
      pendingFetch = { resolve, timer };
      try {
        document.dispatchEvent(new CustomEvent('SD_FETCH_YT_TRACK', { detail: { langPref: langPref || 'de', nativeLang: nativeLang || '' } }));
      } catch (e) { clearPending(); resolve(null); }
    });
  }

  // Duong NHANH: fetch truc tiep tu ISOLATED (same-origin youtube.com -> co cookie,
  // khong can POT). Chay duoc khi tracklist da bat duoc; video chan tai phu de se
  // tra rong -> tra null va de duong POT lo.
  async function legacyFetchYouTubeTrack(langPref, nativeLang, opts) {
    opts = opts || {};
    const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : 5000;
    if (!lastTracklist || !lastTracklist.length) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 250));
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
      if (!opts.silent) emitSentences(sentences, { source: 'youtube', auto: true });
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
        autoLoadedFor = '';
        listeners.forEach((cb) => { try { cb([], { source: 'navigation', navigate: true }); } catch (e) {} });
      }
    }
  }, 500);

  // Ask MAIN world to expose tracklist now (handles case where early retries fired before ISOLATED world was ready)
  try { document.dispatchEvent(new CustomEvent('SD_REQUEST_TRACKLIST')); } catch (e) {}

  root.SD.bridge = { onSubtitles, emitSentences, fetchYouTubeTrack, getAvailableTracks, hasTracklist: () => !!lastTracklist };
})(window);
