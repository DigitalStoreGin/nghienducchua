/* Web Worker (ES module). Chạy Whisper qua transformers.js CỤC BỘ (vendor/).
 * Model do mic-service chọn theo cấu hình máy (tiny/base/small) rồi gửi sang.
 * Model Whisper tải từ HuggingFace lần đầu (~40–480MB tùy model) rồi browser cache.
 * Thiếu vendor/transformers.min.js -> import lỗi -> mic-service tự fallback Web Speech.
 *
 * NÂNG CẤP DẦN (progressive): mic-service nạp model NHỎ trước (tiny) để khách dùng
 * NGAY, rồi gửi lệnh 'upgrade' để nạp model phù hợp máy Ở NỀN — KHÔNG đụng tới
 * pipe đang dùng cho tới khi model mới sẵn sàng (swap nguyên tử). Nhờ vậy khách
 * không phải chờ tải model lớn mới ghi âm được. */
let pipe = null;          // pipe ĐANG dùng để phiên dịch
let loading = null;       // promise nạp model đầu tiên
let curModel = 'Xenova/whisper-tiny';
let curThreads = 1;
let upgrading = null;     // promise nạp model nâng cấp Ở NỀN

// Khởi tạo 1 pipeline Whisper (không đụng tới biến toàn cục — chỉ trả về pipe mới).
async function buildPipe(model, numThreads) {
  // Import transformers.js cục bộ (do download-vendor.* tải về & nhúng sẵn)
  const mod = await import('./vendor/transformers.min.js');
  const { pipeline, env } = mod;
  // Chạy WASM cục bộ (không tải .wasm từ CDN -> hợp CSP extension)
  env.allowLocalModels = false;          // model lấy từ HuggingFace
  env.allowRemoteModels = true;
  env.backends.onnx.wasm.wasmPaths = (self.chrome && chrome.runtime)
    ? chrome.runtime.getURL('vendor/') : './vendor/';
  env.backends.onnx.wasm.numThreads = numThreads || 1; // đa luồng nếu máy hỗ trợ (crossOriginIsolated)
  const p = await pipeline('automatic-speech-recognition', model, {
    quantized: true,                     // bản nén int8 -> nhẹ RAM, hợp máy 4GB
    progress_callback: (x) => {
      if (x && x.status) {
        const prog = x.progress != null ? Math.round(x.progress) : null;
        self.postMessage({ type: 'progress', status: x.status, progress: prog, model });
      }
    },
  });
  p.__model = model;
  return p;
}

// Lấy pipe ĐANG dùng (nạp model đầu nếu chưa có). Đổi model -> nạp lại.
async function getPipe(model, numThreads) {
  if (model && model !== curModel) { curModel = model; pipe = null; loading = null; } // đổi model -> nạp lại
  if (numThreads) curThreads = numThreads;
  if (pipe) return pipe;
  if (loading) return loading;

  loading = buildPipe(curModel, curThreads).then((p) => {
    self.postMessage({ type: 'ready', model: curModel });
    return p;
  });

  try { pipe = await loading; } finally { loading = null; }
  return pipe;
}

// Nâng cấp Ở NỀN: nạp model mạnh hơn mà KHÔNG đụng tới pipe đang dùng.
// Khi xong mới swap (pipe = model mới) rồi báo 'upgraded' để mic-service đổi model dùng.
async function upgradePipe(model, numThreads) {
  if (!model || (model === curModel && pipe)) { self.postMessage({ type: 'upgraded', model: curModel }); return; }
  if (upgrading) return;
  upgrading = buildPipe(model, numThreads || curThreads)
    .then((p) => {
      pipe = p; curModel = model; if (numThreads) curThreads = numThreads;
      self.postMessage({ type: 'upgraded', model });
    })
    .catch((err) => {
      // Nâng cấp lỗi -> giữ nguyên model nhỏ đang chạy (không kẹt khách).
      self.postMessage({ type: 'error', id: 'upgrade', error: String(err.message || err) });
    })
    .finally(() => { upgrading = null; });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'warmup') {
    try { await getPipe(m.model, m.numThreads); }
    catch (err) { self.postMessage({ type: 'error', id: 'warmup', error: String(err.message || err) }); }
    return;
  }
  if (m.type === 'upgrade') {
    // Nạp model phù hợp máy Ở NỀN (sau khi model nhỏ đã sẵn sàng).
    upgradePipe(m.model, m.numThreads);
    return;
  }
  if (m.type === 'transcribe') {
    try {
      const p = await getPipe(m.model, m.numThreads);
      const out = await p(m.audio, {
        language: m.language || 'german', task: 'transcribe',
        return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5,
      });
      const words = (out.chunks || []).map((c) => ({
        text: (c.text || '').trim(),
        startMs: Math.round((c.timestamp?.[0] || 0) * 1000),
        endMs: Math.round((c.timestamp?.[1] || 0) * 1000),
      }));
      self.postMessage({ type: 'result', id: m.id, text: (out.text || '').trim(), words, model: curModel });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, error: String(err.message || err) });
    }
  }
};
