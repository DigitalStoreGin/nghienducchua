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

  // --- Tach mot cau (co the chua nhieu cau con / qua dai) thanh tung cau ngan --
  // Hoc tu splitSegmentBySentences cua ShadowEcho: chia thoi gian theo do dai chu.
  // Muc tieu: moi doan shadowing la MOT cau tron ven, khong qua dai (de luyen
  // tung cau mot). Vi du "Hallo. Hallo. Wir freuen uns..." -> 3 doan rieng.
  const SENT_MAX = 90; // do dai toi da (ky tu) cho 1 doan truoc khi tach theo menh de

  // Cac chu viet tat tieng Duc/chung — KHONG duoc coi dau cham la het cau.
  // Gom: ten goi (Dr., Prof.…), don vi/viet tat (usw., bzw.…), 1 chu cai hoa
  // (B. trong "z. B."), va so thu tu (3.).
  const ABBR_END = /(?:\b(?:Dr|Prof|Hr|Fr|Frl|Nr|St|Str|Mr|Mrs|Ms|Vs|ca|usw|bzw|etc|evtl|ggf|inkl|max|min|Mio|Mrd|Abk|Jh|Jhd|sog|Bd|Aufl|Hrsg|geb|gest|verh|Tel|Abs|Art|Kap|Pos|ehem|vgl|z|B|d|h|u|a|o|s|ff|f)\.|\b\p{Lu}\.|\d+\.)\s*$/u;

  // Tach van ban thanh cac cau con theo dau ket cau:
  //  - tach khi sau dau cham la chu HOA / so (kieu Duc: dau cau / danh tu viet hoa)
  //  - nhung gop lai neu manh truoc ket thuc bang chu viet tat (ABBR_END)
  function splitIntoSentences(text) {
    const raw = String(text).split(/(?<=[.!?…]['")\]]?)\s+(?=[A-ZÄÖÜ0-9])/);
    const out = [];
    for (const piece of raw) {
      const p = piece.trim(); if (!p) continue;
      if (out.length && ABBR_END.test(out[out.length - 1])) {
        out[out.length - 1] = (out[out.length - 1] + ' ' + p).replace(/\s+/g, ' ').trim();
      } else {
        out.push(p);
      }
    }
    return out;
  }

  // Tach 1 cau dai theo menh de (dau phay / cham phay / hai cham), gom cac manh
  // ngan ke nhau cho gan SENT_MAX de khong bi vun qua nhieu.
  function splitByClauses(text) {
    const sub = String(text).split(/(?<=[,;:])\s+/).map((t) => t.trim()).filter(Boolean);
    if (sub.length <= 1) return [text];
    const out = [];
    let buf = '';
    for (const piece of sub) {
      if (!buf) buf = piece;
      else if ((buf + ' ' + piece).length <= SENT_MAX) buf += ' ' + piece;
      else { out.push(buf); buf = piece; }
    }
    if (buf) out.push(buf);
    return out;
  }

  function splitLongSentence(s) {
    const text = (s.text || '').trim();
    if (!text) return [s];
    // Buoc 1: luon tach theo dau ket cau -> moi cau tron ven thanh 1 doan
    let parts = splitIntoSentences(text);
    // Buoc 2: cau con nao van qua dai -> tach tiep theo menh de
    const refined = [];
    for (const p of parts) {
      if (p.length <= SENT_MAX) refined.push(p);
      else for (const q of splitByClauses(p)) refined.push(q);
    }
    parts = refined.filter(Boolean);
    if (parts.length <= 1) return [{ startMs: s.startMs, endMs: s.endMs, text: parts[0] || text }];
    // Buoc 3: chia thoi gian theo ty le do dai chu cua tung doan
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

  // --- Gán bản dịch (cue) vào câu theo ĐIỂM GIỮA -----------------------------
  // Mỗi cue dịch thuộc đúng 1 câu -> KHÔNG lặp bản dịch khi câu dài bị tách
  // (splitLongSentence). Dùng cho phụ đề tự động YouTube (data + tlang).
  function attachTranslations(sentences, tcues) {
    if (!sentences || !tcues || !tcues.length) return sentences;
    for (const s of sentences) {
      const parts = [];
      for (const c of tcues) {
        const mid = (c.startMs + c.endMs) / 2;
        if (mid >= s.startMs && mid < s.endMs) parts.push(c.text);
      }
      if (parts.length) s.trans = parts.join(' ').replace(/\s+/g, ' ').trim();
    }
    return sentences;
  }

  const API = { tcToMs, stripTags, parseSRT, parseVTT, parseJson3, parseTTML, parseAuto, mergeIntoSentences, attachTranslations };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) { root.SD = root.SD || {}; root.SD.parsers = API; }
})(typeof window !== 'undefined' ? window : null);
