/* Web Worker (ES module). Chạy Whisper qua transformers.js CỤC BỘ (vendor/).
 * Model do mic-service chọn theo cấu hình máy (tiny/base/small) rồi gửi sang.
 * Model Whisper tải từ HuggingFace lần đầu (~40–480MB tùy model) rồi browser cache.
 * Thiếu vendor/transformers.min.js -> import lỗi -> mic-service tự fallback Web Speech. */
let pipe = null;
let loading = null;
let curModel = 'Xenova/whisper-base';
let curThreads = 1;

async function getPipe(model, numThreads) {
  if (model && model !== curModel) { curModel = model; pipe = null; loading = null; } // đổi model -> nạp lại
  if (numThreads) curThreads = numThreads;
  if (pipe) return pipe;
  if (loading) return loading;

  loading = (async () => {
    // Import transformers.js cục bộ (do download-vendor.* tải về & nhúng sẵn)
    const mod = await import('./vendor/transformers.min.js');
    const { pipeline, env } = mod;
    // Chạy WASM cục bộ (không tải .wasm từ CDN -> hợp CSP extension)
    env.allowLocalModels = false;          // model lấy từ HuggingFace
    env.allowRemoteModels = true;
    env.backends.onnx.wasm.wasmPaths = (self.chrome && chrome.runtime)
      ? chrome.runtime.getURL('vendor/') : './vendor/';
    env.backends.onnx.wasm.numThreads = curThreads; // đa luồng nếu máy hỗ trợ (crossOriginIsolated)
    const p = await pipeline('automatic-speech-recognition', curModel, {
      quantized: true,                     // bản nén int8 -> nhẹ RAM, hợp máy 4GB
      progress_callback: (x) => {
        if (x && x.status) {
          const prog = x.progress != null ? Math.round(x.progress) : null;
          self.postMessage({ type: 'progress', status: x.status, progress: prog, model: curModel });
        }
      },
    });
    p.__model = curModel;
    self.postMessage({ type: 'ready', model: curModel });
    return p;
  })();

  try { pipe = await loading; } finally { loading = null; }
  return pipe;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'warmup') {
    try { await getPipe(m.model, m.numThreads); }
    catch (err) { self.postMessage({ type: 'error', id: 'warmup', error: String(err.message || err) }); }
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
