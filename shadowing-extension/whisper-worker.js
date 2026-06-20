/* Web Worker (ES module). Nap Whisper qua transformers.js CUC BO (vendor/).
 * Model "Xenova/whisper-base" tai tu HuggingFace lan dau (~145MB) roi cache.
 * Neu thieu vendor/transformers.min.js -> import that bai -> offscreen fallback. */
let pipe = null;
let loading = null;

async function getPipe() {
  if (pipe) return pipe;
  if (loading) return loading;
  loading = (async () => {
    // Import transformers.js cuc bo (do download-vendor.* tai ve)
    const mod = await import('./vendor/transformers.min.js');
    const { pipeline, env } = mod;
    // Chay WASM cuc bo (khong tai .wasm tu CDN -> hop CSP extension)
    env.allowLocalModels = false;          // model lay tu HuggingFace
    env.allowRemoteModels = true;
    env.backends.onnx.wasm.wasmPaths = (self.chrome && chrome.runtime)
      ? chrome.runtime.getURL('vendor/') : './vendor/';
    env.backends.onnx.wasm.numThreads = 1; // on dinh tren may yeu
    const p = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
      progress_callback: (x) => {
        if (x && x.status) {
          const prog = x.progress != null ? Math.round(x.progress) : null;
          self.postMessage({ type: 'progress', status: x.status, progress: prog });
        }
      },
    });
    self.postMessage({ type: 'ready' });
    return p;
  })();
  pipe = await loading;
  return pipe;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'warmup') { try { await getPipe(); } catch (err) { self.postMessage({ type: 'error', id: 'warmup', error: String(err.message || err) }); } return; }
  if (m.type === 'transcribe') {
    try {
      const p = await getPipe();
      const out = await p(m.audio, {
        language: 'german', task: 'transcribe',
        return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5,
      });
      const words = (out.chunks || []).map((c) => ({
        text: (c.text || '').trim(),
        startMs: Math.round((c.timestamp?.[0] || 0) * 1000),
        endMs: Math.round((c.timestamp?.[1] || 0) * 1000),
      }));
      self.postMessage({ type: 'result', id: m.id, text: (out.text || '').trim(), words });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, error: String(err.message || err) });
    }
  }
};
