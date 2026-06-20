/* Dieu khien <video> HTML5 tren YouTube & Netflix.
 * Lay video dong (SPA an toan) - re-query moi lan goi.
 *
 * Cai tien theo Trancy/Language Reactor:
 * - play() tra ve Promise, catch Autoplay Policy
 * - isPaused(), isEnded(), getReadyState() helpers
 * - Ad detection cho YouTube (.ad-showing)
 * - Event listeners: emit events cho engine khi video pause/play/seeking/ended */
(function (root) {
  'use strict';
  root.SD = root.SD || {};

  function getVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('video') || null;
  }

  function getPlayer() {
    return document.querySelector('.html5-video-player') ||
           document.querySelector('#movie_player') || null;
  }

  const eventListeners = {};
  function on(name, cb) { (eventListeners[name] = eventListeners[name] || []).push(cb); }
  function emitEvent(name, data) {
    (eventListeners[name] || []).forEach((cb) => { try { cb(data); } catch (e) {} });
  }

  // --- Ad detection (YouTube) ---
  function isAdPlaying() {
    const player = getPlayer();
    if (!player) return false;
    return player.classList.contains('ad-showing') ||
           player.classList.contains('ad-interrupting') ||
           !!document.querySelector('.ytp-ad-player-overlay');
  }

  // --- Video event watchers ---
  let watchedVideo = null;
  function watchVideoEvents() {
    const v = getVideo();
    if (!v || v === watchedVideo) return;
    watchedVideo = v;
    v.addEventListener('pause', () => emitEvent('pause', {}));
    v.addEventListener('play', () => emitEvent('play', {}));
    v.addEventListener('seeking', () => emitEvent('seeking', { time: v.currentTime }));
    v.addEventListener('ended', () => emitEvent('ended', {}));
    v.addEventListener('waiting', () => emitEvent('waiting', {}));
    v.addEventListener('playing', () => emitEvent('playing', {}));
  }
  // Poll de bat video moi (SPA navigation)
  setInterval(watchVideoEvents, 1000);

  const ctrl = {
    get el() { return getVideo(); },
    getCurrentTime() { const v = getVideo(); return v ? v.currentTime : 0; },
    seekTo(sec) { const v = getVideo(); if (v) v.currentTime = sec; },
    play() {
      const v = getVideo();
      if (!v) return Promise.reject(new Error('no-video'));
      try {
        const p = v.play();
        if (p && typeof p.then === 'function') return p;
      } catch (e) { return Promise.reject(e); }
      return Promise.resolve();
    },
    pause() { const v = getVideo(); if (v) v.pause(); },
    setRate(r) { const v = getVideo(); if (v) v.playbackRate = r; },
    get duration() { const v = getVideo(); return v ? v.duration : 0; },
    isReady() { return !!getVideo(); },
    isPaused() { const v = getVideo(); return v ? v.paused : true; },
    isEnded() { const v = getVideo(); return v ? v.ended : false; },
    getReadyState() { const v = getVideo(); return v ? v.readyState : 0; },
    isAdPlaying,
    on,
  };
  root.SD.video = ctrl;
})(window);
