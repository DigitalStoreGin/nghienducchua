/* video-subs.js — Phụ đề kép hiện TRÊN video (YouTube/Netflix), đồng bộ theo câu hiện tại.
 * Cai tien: dung V().on() events, retry attach moi 2s. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  function start() {
    const SD = root.SD;
    if (!SD.engine) return setTimeout(start, 500);
    const st = document.createElement('style');
    st.textContent = '#sd-vsubs{position:absolute;left:0;right:0;bottom:9%;text-align:center;z-index:60;display:none;padding:0 6%;pointer-events:none}' +
      '#sd-vsubs .de{display:inline-block;background:rgba(0,0,0,.74);color:#fff;font-size:26px;font-weight:600;padding:4px 12px;border-radius:6px;line-height:1.35;max-width:100%}' +
      '#sd-vsubs .tr{display:block;margin-top:4px}#sd-vsubs .tr span{display:inline-block;background:rgba(0,0,0,.55);color:#e5e7eb;font-size:18px;padding:2px 10px;border-radius:6px}';
    document.documentElement.appendChild(st);
    const ov = document.createElement('div'); ov.id = 'sd-vsubs';
    ov.innerHTML = '<div class="de"></div><div class="tr"></div>';
    function attach() {
      const p = document.querySelector('.html5-video-player') || document.querySelector('#movie_player') ||
        document.querySelector('[data-uia="player"]') || document.querySelector('.watch-video');
      if (p && ov.parentElement !== p) p.appendChild(ov);
    }
    attach(); setInterval(attach, 2000);
    let enabled = true;
    SD.engine.listen('current', (c) => {
      const s = c.sentence; if (!s || !enabled) { ov.style.display = 'none'; return; }
      ov.querySelector('.de').textContent = s.text;
      ov.querySelector('.tr').innerHTML = s.trans ? ('<span>' + s.trans + '</span>') : '';
      ov.style.display = 'block';
    });
    SD.videoSubs = { show: (b) => { enabled = b; if (!b) ov.style.display = 'none'; } };
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})(window);
