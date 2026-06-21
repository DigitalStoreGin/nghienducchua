/**
 * ShadowEcho — Chọn model Whisper theo cấu hình máy (nguồn chân lý duy nhất).
 * UMD: dùng được cả trong trình duyệt (window.WhisperSelect) lẫn Node (require) để test.
 *
 * NGUYÊN TẮC (theo yêu cầu): luôn chạy tiny (~75MB) TRƯỚC cho sẵn sàng nhanh, rồi
 * TỰ NÂNG CẤP lên model lớn hơn TÙY MÁY KHÁCH — chọn theo % RAM model chiếm:
 *   - model chiếm ≤ 15% RAM  → được phép nâng lên model đó (cao hơn tiny)
 *   - model chiếm ≥ 25% RAM  → chỉ chạy tiny (75MB) cho mượt
 *   - TRẦN TUYỆT ĐỐI 2GB     → không bao giờ vượt (large-v3 ~3GB bị loại)
 * transformers.js v2 chạy WASM (CPU) -> cũng cần đủ nhân CPU cho model lớn.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node/Vitest
  if (root) root.WhisperSelect = api;                                        // Browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ramGB = bộ nhớ runtime ĐỈNH ước lượng (lớn hơn file tải vì còn heap WASM + tensor).
  // tiny(~75MB file) < base(~145MB) < small(~480MB) < medium(~1.5GB). Bản quantized int8.
  // Trần 2GB -> top là medium (~1.5GB). large-v3-turbo (~2GB) cần transformers.js v3 (WebGPU).
  const MAX_GB = 2.0; // trần tuyệt đối theo yêu cầu khách
  const WHISPER_MODELS = {
    tiny:   { id: 'Xenova/whisper-tiny',   label: 'Tiny (~75MB, nhẹ nhất)', short: 'tiny',   ramGB: 0.25 },
    base:   { id: 'Xenova/whisper-base',   label: 'Base (~145MB)',          short: 'base',   ramGB: 0.50 },
    small:  { id: 'Xenova/whisper-small',  label: 'Small (~480MB)',         short: 'small',  ramGB: 1.00 },
    medium: { id: 'Xenova/whisper-medium', label: 'Medium (~1.5GB, mạnh)',  short: 'medium', ramGB: 2.00 },
  };

  function detectHardware() {
    const nav = (typeof navigator !== 'undefined') ? navigator : {};
    const mem = nav.deviceMemory || 4;          // GB (Chrome giới hạn tối đa 8)
    const cores = nav.hardwareConcurrency || 2; // số luồng CPU
    const gpu = !!(nav.gpu);                      // WebGPU (dự phòng nâng cấp v3)
    const coi = (typeof self !== 'undefined') ? !!self.crossOriginIsolated : false;
    return { mem, cores, gpu, coi };
  }

  // navigator.deviceMemory bị Chrome chặn tối đa 8 -> máy mạnh (16/32GB) vẫn báo 8.
  // Dùng số nhân CPU để suy ra RAM thực: nhiều nhân => máy mạnh => RAM cao hơn.
  function effectiveMem(hw) {
    let mem = hw.mem;
    if (mem >= 8) {
      if (hw.cores >= 16) mem = 32;
      else if (hw.cores >= 12) mem = 24;
      else if (hw.cores >= 8) mem = 16;
    }
    return mem;
  }

  // hw có thể truyền vào để test; override = 'auto'|'tiny'|'base'|'small'|'medium'
  // Chọn model LỚN NHẤT thoả: chiếm ≤15% RAM, ≤2GB, và đủ nhân CPU. Không thoả -> tiny.
  function pickWhisperModel(hw, override) {
    if (override && override !== 'auto' && WHISPER_MODELS[override]) return WHISPER_MODELS[override];
    hw = hw || detectHardware();
    const mem = effectiveMem(hw), cores = hw.cores;
    const order = ['medium', 'small', 'base']; // mạnh -> nhẹ; tiny là phương án sàn
    for (const key of order) {
      const m = WHISPER_MODELS[key];
      if (m.ramGB > MAX_GB) continue;            // vượt trần 2GB -> bỏ
      if (m.ramGB / mem > 0.15) continue;        // chiếm >15% RAM -> nặng máy, bỏ
      const coresOk = key === 'medium' ? cores >= 8 : key === 'small' ? cores >= 4 : cores >= 2;
      if (coresOk) return m;
    }
    return WHISPER_MODELS.tiny; // mọi model >15% RAM (hoặc thiếu nhân) -> tiny 75MB cho mượt
  }

  // Số luồng WASM: chỉ >1 khi crossOriginIsolated (có SharedArrayBuffer).
  function pickThreads(hw) {
    hw = hw || detectHardware();
    if (!hw.coi) return 1;
    return Math.max(1, Math.min(4, hw.cores - 1));
  }

  // Thiết bị suy luận: 'webgpu' nếu máy mạnh có WebGPU (nhanh hơn nhiều), ngược lại 'wasm'.
  // LƯU Ý: transformers.js v2 (bản ĐANG nhúng) CHỈ chạy WASM. Bật WebGPU cần nâng
  // vendor lên transformers.js v3 (device:'webgpu', dtype:'q4'/'fp16'). Hàm này để
  // sẵn (đã test) cho lần nâng cấp đó — hiện worker vẫn ép 'wasm' để chạy ổn định.
  function pickDevice(hw) {
    hw = hw || detectHardware();
    return hw.gpu ? 'webgpu' : 'wasm';
  }

  return { WHISPER_MODELS, detectHardware, pickWhisperModel, pickThreads, pickDevice };
});
