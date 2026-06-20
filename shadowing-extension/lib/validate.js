/**
 * ShadowEcho — Kiểm tra kết quả model TRƯỚC khi trả cho khách (nguồn chân lý, có test).
 * UMD: dùng được cả trình duyệt (window.ShadowValidate) lẫn Node (require) để test.
 *
 * Triết lý: LUÔN ưu tiên Whisper + OpenRouter AI. Nhưng nếu kết quả rỗng / sai / "ảo giác"
 * (hallucination) thì coi như KHÔNG hợp lệ -> tầng gọi sẽ tự hạ xuống API miễn phí
 * (Google/Microsoft/MyMemory/YouTube cho dịch; Web Speech cho ghi âm).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node/Vitest
  if (root) root.ShadowValidate = api;                                       // Browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Bản dịch có hợp lệ không? -------------------------------------------
  function isValidTranslation(out, src, from, to) {
    if (out == null) return false;
    const o = String(out).trim();
    if (!o) return false;
    const s = String(src == null ? '' : src).trim();
    // Thông báo lỗi điển hình do model trả nhầm
    if (/^(error|null|undefined|n\/a|none)\.?$/i.test(o)) return false;
    // Dịch SANG ngôn ngữ khác mà trả y hệt nguồn (câu đủ dài) -> không dịch được
    if (from && to && from !== to && s.length > 8 && o.toLowerCase() === s.toLowerCase()) return false;
    // Quá ngắn bất thường so với nguồn -> hỏng
    if (s.length > 24 && o.length < 2) return false;
    return true;
  }

  // --- Bản phiên âm (Whisper) có "thật" không, hay là ảo giác/lặp? -----------
  // Trả false khi: rỗng, hoặc lặp 1 từ/cụm quá nhiều (Whisper hay "ảo" khi im lặng/nhạc).
  // LƯU Ý: chuỗi rỗng = khách CHƯA nói -> tầng gọi xử lý riêng (không nên re-record).
  function isGoodTranscript(text) {
    if (text == null) return false;
    const t = String(text).trim();
    if (!t) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    if (words.length >= 5) {
      const counts = Object.create(null);
      for (const w of words) {
        const k = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (k) counts[k] = (counts[k] || 0) + 1;
      }
      const keys = Object.keys(counts);
      const uniq = keys.length;
      // >75% là từ trùng -> ảo giác
      if (uniq <= Math.max(1, Math.ceil(words.length * 0.25))) return false;
      // 1 từ chiếm ≥60% tổng -> ảo giác
      let maxRep = 0;
      for (const k of keys) if (counts[k] > maxRep) maxRep = counts[k];
      if (maxRep >= Math.ceil(words.length * 0.6)) return false;
    }
    return true;
  }

  // Phân loại nhanh kết quả ghi âm: 'ok' | 'empty' (chưa nói) | 'bad' (ảo giác).
  function classifyTranscript(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return 'empty';
    return isGoodTranscript(t) ? 'ok' : 'bad';
  }

  return { isValidTranslation, isGoodTranscript, classifyTranscript };
});
