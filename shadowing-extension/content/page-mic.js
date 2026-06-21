/* Ghi âm NGAY TRÊN TRANG YouTube/Netflix (origin của trang) — dùng quyền micro mà
 * người dùng đã cấp cho youtube.com, KHÔNG cần mở tab cấp quyền riêng của extension.
 *
 *  - ensure()    : getUserMedia -> hộp thoại micro hiện NGAY trên trang YouTube.
 *  - recognize() : ghi âm + VAD trên trang -> Whisper (nhờ Side Panel chấm) hoặc
 *                  Web Speech chạy thẳng trên trang. Web Speech song song làm dự phòng.
 *
 * Side Panel có thể điều khiển trực tiếp qua message {sd:'page-mic', action}. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  let stream = null;

  async function permission() {
    try { const r = await navigator.permissions.query({ name: 'microphone' }); return r.state; }
    catch (e) { return 'unknown'; }
  }
  async function ensure() {
    if (stream && stream.active && stream.getAudioTracks().some((t) => t.readyState === 'live')) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('media-devices-unavailable');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return true;
  }
  function release() { try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {} stream = null; }

  function downsampleTo16k(input, inputRate) {
    if (inputRate === 16000) return input;
    const ratio = inputRate / 16000;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < output.length; i++) { const pos = i * ratio, lo = Math.floor(pos), mix = pos - lo; output[i] = (input[lo] || 0) * (1 - mix) + (input[lo + 1] || 0) * mix; }
    return output;
  }
  // Float32 [-1,1] -> base64 của PCM Int16 (gọn ~1/2 so với Array số) để gửi qua message.
  function f32ToB64Int16(f32) {
    const buf = new ArrayBuffer(f32.length * 2), view = new DataView(buf);
    for (let i = 0, o = 0; i < f32.length; i++, o += 2) { const v = Math.max(-1, Math.min(1, f32[i])); view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Ghi âm + VAD thích nghi (im lặng -> tự dừng). Cùng logic với mic-service.js bản Side Panel.
  async function recordRaw(opts) {
    const minMs = 600;
    const hangMs = (opts.vad && opts.vad.silenceHangMs) || 900;
    const noSpeechMs = 4500;
    const maxMs = opts.maxMs || 7000;
    await ensure();
    const ac = new AudioContext();
    if (ac.state === 'suspended') await ac.resume();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [], sample = new Float32Array(analyser.fftSize), started = Date.now();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res, rej) => { recorder.onstop = res; recorder.onerror = (e) => rej(e.error || new Error('media-recorder-error')); });
    recorder.start(200);

    let silenceMs = 0, spoke = false, frames = 0, noiseSum = 0, noiseN = 0, thresh = 0.02;
    const FRAME = 50;
    const monitor = setInterval(() => {
      analyser.getFloatTimeDomainData(sample);
      let rms = 0; for (let i = 0; i < sample.length; i++) rms += sample[i] * sample[i]; rms = Math.sqrt(rms / sample.length);
      frames++; const elapsed = frames * FRAME;
      if (elapsed <= 400) { noiseSum += rms; noiseN++; thresh = Math.min(0.12, Math.max(0.02, (noiseSum / noiseN) * 2.5 + 0.006)); }
      else if (rms > thresh) { spoke = true; silenceMs = 0; }
      else silenceMs += FRAME;
    }, FRAME);

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (root.SD.pageMic._abort) { clearInterval(timer); resolve(); return; }
        if (root.SD.pageMic._finalize) { clearInterval(timer); resolve(); return; }
        const elapsed = Date.now() - started;
        if (elapsed >= maxMs) { clearInterval(timer); resolve(); return; }
        if (spoke && silenceMs >= hangMs && elapsed >= minMs) { clearInterval(timer); resolve(); return; }
        if (!spoke && elapsed >= noSpeechMs) { clearInterval(timer); resolve(); return; }
      }, 50);
    });

    const spokenMs = Date.now() - started;
    clearInterval(monitor);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    if (root.SD.pageMic._abort) { await ac.close(); throw new Error('recording-aborted'); }
    if (!chunks.length) { await ac.close(); throw new Error('empty-recording'); }
    const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
    const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
    const audio16k = downsampleTo16k(decoded.getChannelData(0), decoded.sampleRate);
    await ac.close();
    return { audio16k, spokenMs, spoke };
  }

  // Web Speech NGAY trên trang (origin youtube.com) — continuous để bắt cả câu.
  //  done: true khi người nói ngừng (speechend) hoặc engine kết thúc -> cho phép
  //  trả kết quả NGAY (trong ~1-2s), không phải chờ hết maxMs.
  function pageWebSpeech(opts) {
    const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!Recognition) return null;
    let transcript = '', rec, done = false;
    try {
      rec = new Recognition();
      rec.lang = opts.lang || 'de-DE'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      rec.onresult = (event) => { let t = ''; for (let i = 0; i < event.results.length; i++) t += ((event.results[i][0] && event.results[i][0].transcript) || '') + ' '; transcript = t.replace(/\s+/g, ' ').trim(); };
      rec.onerror = () => { done = true; };
      // Người nói ngừng -> dừng để engine chốt kết quả cuối (nhanh).
      rec.onspeechend = () => { try { rec.stop(); } catch (e) {} };
      rec.onend = () => { done = true; };
      rec.start();
    } catch (e) { return null; }
    return { get: () => transcript.trim(), isDone: () => done, stop: () => { try { rec.stop(); } catch (e) {} try { rec.abort(); } catch (e) {} } };
  }

  // Nhờ Side Panel chấm Whisper trên audio đã ghi (model + worker nằm ở Side Panel).
  function transcribeViaSidePanel(audio16k, opts) {
    return new Promise((resolve) => {
      let audioB64; try { audioB64 = f32ToB64Int16(audio16k); } catch (e) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage(
          { sd: 'mic-service', action: 'transcribeAudio', audioB64, sampleRate: 16000, opts },
          (resp) => { if (chrome.runtime.lastError || !resp || !resp.ok) resolve(null); else resolve(resp.result); }
        );
      } catch (e) { resolve(null); }
    });
  }

  async function recognize(opts) {
    opts = opts || {};
    root.SD.pageMic._abort = false; root.SD.pageMic._finalize = false;
    const engine = opts.engine || 'webspeech';

    // Web Speech thuần -> chạy thẳng trên trang. Trả kết quả NGAY khi người nói
    // ngừng (ps.isDone) -> chấm trong ~1-2s, không chờ hết maxMs.
    if (engine === 'webspeech') {
      const ps = pageWebSpeech(opts);
      if (!ps) throw new Error('no-webspeech');
      const started = Date.now();
      await new Promise((resolve) => {
        const t = setInterval(() => {
          if (root.SD.pageMic._abort || root.SD.pageMic._finalize) { clearInterval(t); resolve(); return; }
          if (ps.isDone() && ps.get()) { clearInterval(t); resolve(); return; } // nói xong -> chốt ngay
          if (Date.now() - started > (opts.maxMs || 7000)) { clearInterval(t); resolve(); return; }
        }, 80);
      });
      const txt = ps.get(); ps.stop();
      if (root.SD.pageMic._abort) throw new Error('recording-aborted');
      return { transcript: txt, words: [], pitch: [], spokenMs: Date.now() - started, engine: 'webspeech (trang)' };
    }

    // Whisper: ghi âm trên trang + Web Speech SONG SONG (dự phòng) -> Side Panel chấm.
    const parallel = pageWebSpeech(opts);
    let data;
    try { data = await recordRaw(opts); }
    catch (e) { if (parallel) parallel.stop(); throw e; }
    let backup = '';
    if (parallel) { try { await new Promise((r) => setTimeout(r, 250)); backup = parallel.get(); } catch (e) {} parallel.stop(); }

    if (engine === 'whisper') {
      const result = await transcribeViaSidePanel(data.audio16k, opts);
      if (result && result.text != null) {
        const txt = (result.text || '').trim();
        const V = root.ShadowValidate;
        const bad = !!(txt && V && V.classifyTranscript && V.classifyTranscript(txt) === 'bad');
        if ((!txt || bad) && backup) return { transcript: backup, words: [], pitch: [], spokenMs: data.spokenMs, engine: 'webspeech↔whisper (trang)', fallback: true };
        return { transcript: txt, words: result.words || [], pitch: [], spokenMs: data.spokenMs, engine: 'whisper:' + (result.modelShort || '?') + ' (trang)', lowConfidence: bad };
      }
      if (backup) return { transcript: backup, words: [], pitch: [], spokenMs: data.spokenMs, engine: 'webspeech (Whisper Side Panel lỗi)', fallback: true };
      // Side Panel chưa chấm được & không có dự phòng -> trả rỗng (KHÔNG bắt nói lại).
      return { transcript: '', words: [], pitch: [], spokenMs: data.spokenMs, engine: 'whisper (Side Panel chưa sẵn sàng)' };
    }
    // 'server' engine không hỗ trợ tại trang -> để speech.js fallback về Side Panel.
    throw new Error('page-mic-unsupported-engine');
  }

  function abort() { root.SD.pageMic._abort = true; }
  function finalize() { root.SD.pageMic._finalize = true; }

  // Side Panel điều khiển trực tiếp (cấp quyền NGAY trên trang, dừng/kết thúc ghi âm).
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (!msg || msg.sd !== 'page-mic') return;
    (async () => {
      try {
        if (msg.action === 'permission') { reply({ ok: true, state: await permission() }); return; }
        if (msg.action === 'ensure') { await ensure(); reply({ ok: true, state: await permission() }); return; }
        if (msg.action === 'abort') { abort(); reply({ ok: true }); return; }
        if (msg.action === 'finalize') { finalize(); reply({ ok: true }); return; }
        reply({ ok: false, error: 'unknown-action' });
      } catch (e) { reply({ ok: false, error: (e && e.message) || String(e), name: (e && e.name) || 'Error' }); }
    })();
    return true;
  });

  root.SD.pageMic = { ensure, permission, recognize, release, abort, finalize, _abort: false, _finalize: false };
})(window);
