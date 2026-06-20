/* ============================================================================
 * parsers.js — Phan tich phu de tu nhieu nguon + gop cau (sentence merge)
 * Ho tro: SRT, WebVTT, YouTube json3 (timedtext), Netflix TTML/DFXP.
 * Giai quyet loi "caption cuon" cua YouTube: dedup tien to lon dan.
 * Chay duoc trong content script (window.SD.parsers) lan Node (module.exports).
 * ==========================================================================*/
(function (root) {
  'use strict';

  function tcToMs(tc) {
    // "00:01:02,500" hoac "00:01:02.500" hoac "1:02.5"
    const m = String(tc).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
    if (!m) {
      const m2 = String(tc).trim().match(/(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
      if (!m2) return 0;
      return (+m2[1]) * 60000 + (+m2[2]) * 1000 + (+m2[3].padEnd(3, '0'));
    }
    const h = +(m[1] || 0), min = +m[2], s = +m[3], ms = +m[4].padEnd(3, '0');
    return h * 3600000 + min * 60000 + s * 1000 + ms;
  }

  function stripTags(s) {
    return String(s).replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();
  }

  // --- SRT --------------------------------------------------------------------
  function parseSRT(text) {
    const cues = [];
    const blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
    for (const b of blocks) {
      const lines = b.split('\n').filter((x) => x.trim() !== '');
      if (lines.length < 2) continue;
      let idx = 0;
      if (/^\d+$/.test(lines[0].trim())) idx = 1;
      const tm = lines[idx] && lines[idx].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (!tm) continue;
      const startMs = tcToMs(tm[1]), endMs = tcToMs(tm[2]);
      const t = stripTags(lines.slice(idx + 1).join(' '));
      if (t) cues.push({ startMs, endMs, text: t });
    }
    return cues;
  }

  // --- WebVTT -----------------------------------------------------------------
  function parseVTT(text) {
    const cues = [];
    const body = String(text).replace(/\r/g, '');
    const blocks = body.split(/\n\n+/);
    for (const b of blocks) {
      const lines = b.split('\n').filter((x) => x.trim() !== '');
      const tmLine = lines.find((l) => /-->/.test(l));
      if (!tmLine) continue;
      const tm = tmLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (!tm) continue;
      const startMs = tcToMs(tm[1]), endMs = tcToMs(tm[2]);
      const after = lines.slice(lines.indexOf(tmLine) + 1).join(' ');
      const t = stripTags(after);
      if (t) cues.push({ startMs, endMs, text: t });
    }
    return cues;
  }

  // --- YouTube json3 (timedtext fmt=json3) -----------------------------------
  function parseJson3(obj) {
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return []; } }
    const cues = [];
    const events = (obj && obj.events) || [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const txt = stripTags(ev.segs.map((s) => s.utf8 || '').join(''));
      if (!txt || txt === '\n') continue;
      const startMs = ev.tStartMs || 0;
      const endMs = startMs + (ev.dDurationMs || 0);
      cues.push({ startMs, endMs, text: txt });
    }
    return cues;
  }

  // --- Netflix / TTML / DFXP --------------------------------------------------
  function parseTTML(xmlString) {
    const cues = [];
    // Lay tick rate neu co (Netflix dung tick-based times)
    const ttHeader = String(xmlString).match(/<tt[^>]*>/i);
    let tickRate = 0;
    if (ttHeader) {
      const tr = ttHeader[0].match(/ttp:tickRate\s*=\s*"(\d+)"/i);
      if (tr) tickRate = +tr[1];
    }
    const toMs = (v) => {
      if (!v) return 0;
      v = v.trim();
      if (/t$/i.test(v) && tickRate) return Math.round((parseFloat(v) / tickRate) * 1000);
      if (/s$/i.test(v)) return Math.round(parseFloat(v) * 1000);
      if (/ms$/i.test(v)) return Math.round(parseFloat(v));
      return tcToMs(v);
    };
    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(xmlString)) !== null) {
      const attrs = m[1];
      const begin = (attrs.match(/begin\s*=\s*"([^"]+)"/i) || [])[1];
      const end = (attrs.match(/end\s*=\s*"([^"]+)"/i) || [])[1];
      const raw = m[2].replace(/<br\s*\/?>/gi, ' ');
      const t = stripTags(raw);
      if (t) cues.push({ startMs: toMs(begin), endMs: toMs(end), text: t });
    }
    return cues;
  }

  // --- Auto-detect ------------------------------------------------------------
  function parseAuto(text) {
    const s = String(text).trimStart();
    if (s.startsWith('{') || s.startsWith('[')) return parseJson3(s);
    if (/^WEBVTT/.test(s)) return parseVTT(s);
    if (/<tt[\s>]/i.test(s) || /<\?xml/.test(s)) return parseTTML(s);
    if (/-->/.test(s)) return parseSRT(s);
    return [];
  }

  // --- Tach mot cau qua dai (chua nhieu cau con) thanh tung cau ---------------
  // Hoc tu splitSegmentBySentences cua ShadowEcho: chia thoi gian theo do dai chu.
  function splitLongSentence(s) {
    const text = s.text || '';
    if (text.length < 120) return [s];
    const parts = text.split(/(?<=[.!?…])\s+/).map((t) => t.trim()).filter(Boolean);
    if (parts.length <= 1) return [s];
    const total = parts.reduce((a, p) => a + p.length, 0) || 1;
    const dur = Math.max(0, s.endMs - s.startMs);
    let cursor = s.startMs;
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const end = i === parts.length - 1 ? s.endMs : Math.round(cursor + dur * (parts[i].length / total));
      out.push({ startMs: cursor, endMs: end, text: parts[i] });
      cursor = end;
    }
    return out;
  }

  // --- Gop cau: fix caption cuon + gom cac dong thanh cau tron ven ------------
  const ENDERS = /[.!?…]['")\]]?\s*$/;
  function mergeIntoSentences(cues, opts) {
    opts = opts || {};
    const maxGapMs = opts.maxGapMs || 1200;
    const maxChars = opts.maxChars || 240;

    // Buoc 1: dedup tien to lon dan (caption cuon cua YouTube live capture)
    const clean = [];
    for (const c of cues) {
      const prev = clean[clean.length - 1];
      if (prev && c.text.startsWith(prev.text) && c.text.length > prev.text.length) {
        prev.text = c.text; prev.endMs = c.endMs;        // thay vi noi them
      } else if (prev && prev.text === c.text) {
        prev.endMs = c.endMs;                            // trung het: gop thoi gian
      } else {
        clean.push({ startMs: c.startMs, endMs: c.endMs, text: c.text });
      }
    }

    // Buoc 2: gom dong thanh cau theo dau ket cau / khoang lang / do dai
    const out = [];
    let cur = null;
    for (const c of clean) {
      if (!cur) { cur = { startMs: c.startMs, endMs: c.endMs, text: c.text }; }
      else {
        const gap = c.startMs - cur.endMs;
        const tooLong = (cur.text.length + c.text.length) > maxChars;
        if (gap > maxGapMs || tooLong || ENDERS.test(cur.text)) {
          out.push(cur); cur = { startMs: c.startMs, endMs: c.endMs, text: c.text };
        } else {
          cur.text = (cur.text + ' ' + c.text).replace(/\s+/g, ' ').trim();
          cur.endMs = c.endMs;
        }
      }
      if (ENDERS.test(cur.text) && cur.text.length > 12) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    // Buoc 3: tach cau qua dai thanh tung cau de shadowing tung cau mot
    const expanded = [];
    for (const s of out) for (const piece of splitLongSentence(s)) expanded.push(piece);
    return expanded.map((s, i) => ({ id: i, startMs: s.startMs, endMs: s.endMs, text: s.text }));
  }

  const API = { tcToMs, stripTags, parseSRT, parseVTT, parseJson3, parseTTML, parseAuto, mergeIntoSentences };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) { root.SD = root.SD || {}; root.SD.parsers = API; }
})(typeof window !== 'undefined' ? window : null);
