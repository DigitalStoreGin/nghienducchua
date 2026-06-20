/* vad-silero.js — Silero VAD v5 (ONNX) chay trong Side Panel qua onnxruntime-web.
 *
 * Can 2 file dat san trong vendor/ (chay download-vendor de tai):
 *   - ort.min.js            (onnxruntime-web, UMD -> window.ort)
 *   - silero_vad_v5.onnx     (model VAD, ~2MB)
 *   - cac file ort-*.wasm    (da co neu da cai Whisper)
 *
 * FAIL-SAFE: neu thieu file hoac loi -> available() = false, mic-service tu quay ve
 * VAD theo RMS (khong vo luong ghi am).
 *
 * Silero v5 I/O: input float32[1,512] @16kHz, state float32[2,1,128], sr int64[1]=16000
 *                -> output float32[1,1] (xac suat co giong noi), stateN float32[2,1,128]. */
(function (root) {
  'use strict';
  let session = null, loading = null;

  function url(p) { try { return chrome.runtime.getURL('vendor/' + p); } catch (e) { return 'vendor/' + p; } }

  async function ensureOrt() {
    if (root.ort) return root.ort;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url('ort.min.js');
      s.onload = res; s.onerror = () => rej(new Error('no-ort'));
      document.head.appendChild(s);
    });
    if (!root.ort) throw new Error('no-ort');
    try { root.ort.env.wasm.wasmPaths = url(''); root.ort.env.wasm.numThreads = 1; } catch (e) {}
    return root.ort;
  }

  async function getSession() {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      const ort = await ensureOrt();
      session = await ort.InferenceSession.create(url('silero_vad_v5.onnx'), { executionProviders: ['wasm'] });
      return session;
    })();
    return loading;
  }

  // Co du file de chay khong?
  async function available() {
    try {
      const a = await fetch(url('silero_vad_v5.onnx'), { method: 'HEAD' });
      const b = await fetch(url('ort.min.js'), { method: 'HEAD' });
      return !!(a && a.ok && b && b.ok);
    } catch (e) { return false; }
  }

  // Tra ve detector: process(Float32Array(512)@16k) -> Promise<prob 0..1>
  async function createDetector() {
    const ort = await ensureOrt();
    const sess = await getSession();
    const newState = () => new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    let state = newState();
    const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [1]);
    return {
      async process(frame) {
        const input = new ort.Tensor('float32', frame, [1, frame.length]);
        const out = await sess.run({ input, state, sr });
        if (out.stateN) state = out.stateN; else if (out.state) state = out.state;
        const o = out.output || out.out || Object.values(out)[0];
        return (o && o.data) ? o.data[0] : 0;
      },
      reset() { state = newState(); },
    };
  }

  root.SileroVAD = { available, createDetector };
})(window);
