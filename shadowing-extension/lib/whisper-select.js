/**
 * ShadowEcho — Chọn model Whisper theo cấu hình máy (nguồn chân lý duy nhất).
 * UMD: dùng được cả trong trình duyệt (window.WhisperSelect) lẫn Node (require) để test.
 *
 * Mục tiêu: chạy mượt trên máy 4GB–8GB. transformers.js v2 chạy WASM (CPU).
 * Chọn model MẠNH NHẤT mà máy vẫn chạy được:
 *   - RAM ≥ 8GB & CPU ≥ 8 nhân  → small (mạnh nhất)
 *   - RAM ≥ 4GB & CPU ≥ 4 nhân  → base  (cân bằng)
 *   - RAM ≥ 4GB (ít nhân)        → tiny  (nhẹ cho mượt)
 *   - thấp hơn                   → tiny
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node/Vitest
  if (root) root.WhisperSelect = api;                                        // Browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // tiny(~75MB) < base(~145MB) < small(~480MB). Bản quantized int8.
  const WHISPER_MODELS = {
    tiny:  { id: 'Xenova/whisper-tiny',  label: 'Tiny (nhẹ, máy yếu)', short: 'tiny' },
    base:  { id: 'Xenova/whisper-base',  label: 'Base (cân bằng)',      short: 'base' },
    small: { id: 'Xenova/whisper-small', label: 'Small (mạnh nhất)',    short: 'small' },
  };

  function detectHardware() {
    const nav = (typeof navigator !== 'undefined') ? navigator : {};
    const mem = nav.deviceMemory || 4;          // GB (Chrome giới hạn tối đa 8)
    const cores = nav.hardwareConcurrency || 2; // số luồng CPU
    const gpu = !!(nav.gpu);                      // WebGPU (dự phòng nâng cấp v3)
    const coi = (typeof self !== 'undefined') ? !!self.crossOriginIsolated : false;
    return { mem, cores, gpu, coi };
  }

  // hw có thể truyền vào để test; override = 'auto'|'tiny'|'base'|'small'
  function pickWhisperModel(hw, override) {
    if (override && override !== 'auto' && WHISPER_MODELS[override]) return WHISPER_MODELS[override];
    hw = hw || detectHardware();
    const mem = hw.mem, cores = hw.cores;
    if (mem >= 8 && cores >= 8) return WHISPER_MODELS.small;
    if (mem >= 6 && cores >= 4) return WHISPER_MODELS.base;
    if (mem >= 4 && cores >= 4) return WHISPER_MODELS.base;
    if (mem >= 4)               return WHISPER_MODELS.tiny;
    return WHISPER_MODELS.tiny;
  }

  // Số luồng WASM: chỉ >1 khi crossOriginIsolated (có SharedArrayBuffer).
  function pickThreads(hw) {
    hw = hw || detectHardware();
    if (!hw.coi) return 1;
    return Math.max(1, Math.min(4, hw.cores - 1));
  }

  return { WHISPER_MODELS, detectHardware, pickWhisperModel, pickThreads };
});
