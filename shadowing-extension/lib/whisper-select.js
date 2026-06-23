/**
 * ShadowEcho — Chọn model Whisper theo cấu hình máy (nguồn chân lý duy nhất).
 * UMD: dùng được cả trong trình duyệt (window.WhisperSelect) lẫn Node (require) để test.
 *
 * NGUYÊN TẮC (v3):
 *   - SÀNG (floor)  : base (~145 MB) — không bao giờ xuống tiny trong chế độ auto
 *   - TRẦN (ceiling): small (~480 MB) — medium bị loại khỏi auto (quá nặng cho ext)
 *   - NGƯỠNG RAM    : model chiếm ≤ 30 % RAM khả dụng → được phép
 *   - ƯU TIÊN       : nếu máy không quá yếu (≥ 3.3 GB RAM & ≥ 4 CPU cores) → small
 *   - DỰ PHÒNG      : nếu small quá nặng → base
 *
 * Bảng nhanh (30 % ngưỡng):
 *   ≤ 3.3 GB RAM  → base  (small chiếm > 30 %)
 *   4–7 GB RAM    → small (small ≈ 25 %)
 *   ≥ 8 GB RAM    → small (thoải mái; medium bị loại theo chính sách ceiling)
 *
 * transformers.js v2 chạy WASM (CPU) — cũng cần đủ nhân.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node/Vitest
  if (root) root.WhisperSelect = api;                                        // Browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ramGB = bộ nhớ runtime ĐỈNH ước lượng (lớn hơn file tải vì còn heap WASM + tensor).
  // tiny(~75MB file) < base(~145MB) < small(~480MB) < medium(~1.5GB). Bản quantized int8.
  const WHISPER_MODELS = {
    tiny:   { id: 'Xenova/whisper-tiny',   label: 'Tiny (~75MB, nhẹ nhất)', short: 'tiny',   ramGB: 0.25 },
    base:   { id: 'Xenova/whisper-base',   label: 'Base (~145MB, nhanh)',   short: 'base',   ramGB: 0.50 },
    small:  { id: 'Xenova/whisper-small',  label: 'Small (~480MB, tốt nhất auto)', short: 'small',  ramGB: 1.00 },
    medium: { id: 'Xenova/whisper-medium', label: 'Medium (~1.5GB, rất mạnh)', short: 'medium', ramGB: 2.00 },
  };

  // Ngưỡng RAM cho chế độ auto: model không được chiếm quá X% RAM khả dụng.
  const RAM_PCT_LIMIT = 0.30; // 30 %
  // Trần tuyệt đối cho chế độ auto (medium ~2GB bị loại).
  const AUTO_CEILING = 'small';
  // Sàn tuyệt đối cho chế độ auto (tiny bị loại).
  const AUTO_FLOOR   = 'base';

  function detectHardware() {
    const nav = (typeof navigator !== 'undefined') ? navigator : {};
    const mem   = nav.deviceMemory || 4;          // GB (Chrome giới hạn tối đa 8)
    const cores = nav.hardwareConcurrency || 2;   // số luồng CPU
    const gpu   = !!(nav.gpu);                    // WebGPU (dự phòng nâng cấp v3)
    const coi   = (typeof self !== 'undefined') ? !!self.crossOriginIsolated : false;
    return { mem, cores, gpu, coi };
  }

  // navigator.deviceMemory bị Chrome chặn tối đa 8 → máy mạnh (16/32GB) vẫn báo 8.
  // Dùng số nhân CPU để suy ra RAM thực: nhiều nhân → máy mạnh → RAM cao hơn.
  function effectiveMem(hw) {
    let mem = hw.mem;
    if (mem >= 8) {
      if (hw.cores >= 16) mem = 32;
      else if (hw.cores >= 12) mem = 24;
      else if (hw.cores >= 8) mem = 16;
      // 8 cores → giữ nguyên 8 GB
    }
    return mem;
  }

  // hw có thể truyền vào để test; override = 'auto'|'tiny'|'base'|'small'|'medium'
  function pickWhisperModel(hw, override) {
    // Override thủ công: trả thẳng (power user chọn tay)
    if (override && override !== 'auto' && WHISPER_MODELS[override]) return WHISPER_MODELS[override];

    hw = hw || detectHardware();
    const mem   = effectiveMem(hw);
    const cores = hw.cores;

    // Auto: thử từ ceiling (small) xuống floor (base), chọn model lớn nhất phù hợp.
    // Điều kiện:  (1) ramGB / mem ≤ 30 %  (2) đủ CPU cores cho model.
    const order = [AUTO_CEILING, AUTO_FLOOR]; // ['small', 'base']
    for (const key of order) {
      const m = WHISPER_MODELS[key];
      const ramPct = m.ramGB / mem;
      if (ramPct > RAM_PCT_LIMIT) continue;  // quá nặng (> 30 % RAM) → thử nhỏ hơn
      const minCores = (key === 'small') ? 4 : 2;
      if (cores < minCores) continue;        // quá ít nhân CPU → thử nhỏ hơn
      return m;
    }

    // Sàn bất biến: luôn trả ít nhất base (không bao giờ tiny trong auto)
    return WHISPER_MODELS[AUTO_FLOOR];
  }

  // Trả về chuỗi mô tả lý do chọn (hiển thị trong Settings > hwInfo).
  function describeChoice(hw, override) {
    const m    = pickWhisperModel(hw, override);
    hw         = hw || detectHardware();
    const mem  = effectiveMem(hw);
    const pct  = Math.round((m.ramGB / mem) * 100);
    if (override && override !== 'auto') return m.label + ' (chọn tay)';
    return m.label + ' — ~' + pct + '% RAM (' + mem + ' GB khả dụng, ' + hw.cores + ' cores)';
  }

  // Số luồng WASM: chỉ >1 khi crossOriginIsolated (có SharedArrayBuffer).
  function pickThreads(hw) {
    hw = hw || detectHardware();
    if (!hw.coi) return 1;
    return Math.max(1, Math.min(4, hw.cores - 1));
  }

  // Thiết bị suy luận: 'webgpu' nếu máy mạnh có WebGPU, ngược lại 'wasm'.
  function pickDevice(hw) {
    hw = hw || detectHardware();
    return hw.gpu ? 'webgpu' : 'wasm';
  }

  return { WHISPER_MODELS, detectHardware, effectiveMem, pickWhisperModel, describeChoice, pickThreads, pickDevice };
});
