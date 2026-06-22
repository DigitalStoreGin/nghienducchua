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
  const WORKER_URL = 'https://nghienducchua-proxy.thoatran21012.workers.dev';
  let stream = null;

  async function permission() {
    try { const r = await navigator.permissions.query({ name: 'microphone' }); return r.state; }
    catch (e) { return 'unknown'; }
  }
  async function ensure() {
    if (stream && stream.active && stream.getAudioTracks().some((t) => t.readyState === 'live')) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('media-devices-unavailable');
    // Chống TREO: nếu getUserMedia không trả trong 8s (mic bận / xung đột) → ném lỗi
    // để luồng báo "cần quyền micro" thay vì kẹt mãi gây score-timeout.
    stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getusermedia-timeout')), 8000)),
    ]);
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
    const hangMs = (opts.vad && opts.vad.silenceHangMs) || 600;
    const noSpeechMs = opts.noSpeechMs || 3000; // cho người dùng ~3s để bắt đầu nói
    const noVadStop = !!opts.noVadStop;          // self-test: ghi đủ maxMs để đo mức âm
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

    let silenceMs = 0, spoke = false, frames = 0, noiseSum = 0, noiseN = 0, thresh = 0.02, peakRms = 0;
    const FRAME = 50;
    const monitor = setInterval(() => {
      analyser.getFloatTimeDomainData(sample);
      let rms = 0; for (let i = 0; i < sample.length; i++) rms += sample[i] * sample[i]; rms = Math.sqrt(rms / sample.length);
      if (rms > peakRms) peakRms = rms; // đỉnh âm lượng (để chẩn đoán mic im lặng)
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
        if (noVadStop) return; // self-test: ghi đủ maxMs, không dừng sớm theo VAD
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
    return { audio16k, blob, spokenMs, spoke, peakRms, thresh };
  }

  // Web Speech NGAY trên trang (origin youtube.com) — continuous để bắt cả câu.
  //  done: true khi người nói ngừng (speechend) hoặc engine kết thúc -> cho phép
  //  trả kết quả NGAY (trong ~1-2s), không phải chờ hết maxMs.
  function pageWebSpeech(opts) {
    const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!Recognition) return null;
    let transcript = '', rec, done = false, errCode = null;
    try {
      rec = new Recognition();
      rec.lang = opts.lang || 'de-DE'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      rec.onresult = (event) => { let t = ''; for (let i = 0; i < event.results.length; i++) t += ((event.results[i][0] && event.results[i][0].transcript) || '') + ' '; transcript = t.replace(/\s+/g, ' ').trim(); };
      // Lưu mã lỗi: 'no-speech' = im lặng thật; 'not-allowed'/'service-not-allowed'/
      // 'audio-capture'/'network' = trang chặn hoặc mic bận -> để Side Panel chấm thay.
      rec.onerror = (e) => { errCode = (e && e.error) || 'unknown'; done = true; };
      // Người nói ngừng -> dừng để engine chốt kết quả cuối (nhanh).
      rec.onspeechend = () => { try { rec.stop(); } catch (e) {} };
      rec.onend = () => { done = true; };
      rec.start();
    } catch (e) { return null; }
    return {
      get: () => transcript.trim(),
      isDone: () => done,
      err: () => errCode,
      stop: () => { try { rec.stop(); } catch (e) {} try { rec.abort(); } catch (e) {} },
    };
  }

  // Nhờ Side Panel chấm Whisper trên audio đã ghi (model + worker nằm ở Side Panel).
  // Timeout 15s: nếu Side Panel không trả lời (port đóng / chưa mở) → resolve(null) để
  // caller fallback về Web Speech, tránh treo mãi gây rec:score-timeout.
  function transcribeViaSidePanel(audio16k, opts) {
    return new Promise((resolve) => {
      let audioB64; try { audioB64 = f32ToB64Int16(audio16k); } catch (e) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), 15000);
      try {
        chrome.runtime.sendMessage(
          { sd: 'mic-service', action: 'transcribeAudio', audioB64, sampleRate: 16000, opts },
          (resp) => { clearTimeout(timer); if (chrome.runtime.lastError || !resp || !resp.ok) resolve(null); else resolve(resp.result); }
        );
      } catch (e) { clearTimeout(timer); resolve(null); }
    });
  }

  // Gửi audio blob lên Cloudflare Worker -> Groq Whisper Large v3 Turbo.
  // Trả null nếu thất bại (network, quota, timeout) -> caller fallback sang offline.
  // Uint8Array -> base64 (gửi audio qua message tới background, an toàn với mọi byte).
  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  // Gửi audio sang BACKGROUND service worker để fetch Worker /transcribe.
  // KHÔNG fetch trực tiếp ở content script: CSP (connect-src) của YouTube CHẶN
  // fetch tới domain Worker → request thất bại im lặng (đây là lỗi "ghi xong không
  // có kết quả"). Background SW có host_permissions + không bị page CSP → luôn gọi được.
  async function transcribeViaGroq(blob, lang) {
    if (!blob) return { _err: 'no-blob' };
    let b64;
    try { b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer())); }
    catch (e) { return { _err: 'encode-fail' }; }
    const resp = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, _err: 'bg-timeout' }), 13000);
      try {
        chrome.runtime.sendMessage(
          { sd: 'groq-transcribe', audioB64: b64, mime: blob.type || 'audio/webm', lang: lang || 'de' },
          (r) => { clearTimeout(timer); resolve(chrome.runtime.lastError ? { ok: false, _err: 'bg-' + chrome.runtime.lastError.message } : (r || { ok: false, _err: 'bg-empty' })); }
        );
      } catch (e) { clearTimeout(timer); resolve({ ok: false, _err: 'bg-throw:' + ((e && e.message) || e) }); }
    });
    if (resp && resp.ok && resp.data) return resp.data; // { text, words, ... }
    return { _err: (resp && resp._err) || 'bg-fail' };
  }

  async function recognize(opts) {
    opts = opts || {};
    root.SD.pageMic._abort = false; root.SD.pageMic._finalize = false;
    const engine = opts.engine || 'webspeech';

    // Web Speech thuần -> chạy thẳng trên trang. Trả kết quả NGAY khi người nói
    // ngừng (ps.isDone) -> chấm trong ~1-2s, không chờ hết maxMs.
    if (engine === 'webspeech') {
      // QUAN TRỌNG: nếu đang giữ stream getUserMedia (từ lúc "Bật mic"), webkitSpeechRecognition
      // thường KHÔNG nhận được audio (trả rỗng "Nothing heard"). Nhả stream trước khi nhận dạng.
      release();
      const ps = pageWebSpeech(opts);
      if (!ps) throw new Error('no-webspeech');
      const started = Date.now();
      await new Promise((resolve) => {
        const t = setInterval(() => {
          if (root.SD.pageMic._abort || root.SD.pageMic._finalize) { clearInterval(t); resolve(); return; }
          if (ps.isDone() && ps.get()) { clearInterval(t); resolve(); return; } // nói xong -> chốt ngay
          if (ps.isDone() && ps.err() && ps.err() !== 'no-speech') { clearInterval(t); resolve(); return; } // lỗi engine -> thoát sớm để fallback
          if (Date.now() - started > (opts.maxMs || 7000)) { clearInterval(t); resolve(); return; }
        }, 80);
      });
      const txt = ps.get(); const err = ps.err(); ps.stop();
      if (root.SD.pageMic._abort) throw new Error('recording-aborted');
      // Kết quả rỗng vì bất kỳ lý do gì (lỗi engine, Permissions-Policy trang, mic bận,
      // im lặng) -> ném lỗi để speech.js tự chuyển sang Side Panel nhận dạng thay.
      // Side Panel có quyền "microphone" riêng trong manifest, luôn hoạt động ổn định.
      if (!txt) throw new Error('page-webspeech-' + (err || 'empty'));
      return { transcript: txt, words: [], pitch: [], spokenMs: Date.now() - started, engine: 'webspeech (trang)' };
    }

    // Whisper: CHỈ ghi âm (getUserMedia) rồi gửi Groq chấm. KHÔNG chạy Web Speech
    // song song nữa: SpeechRecognition và getUserMedia tranh chấp micro trên Windows
    // → getUserMedia có thể TREO suốt → score-timeout (đây là lỗi "ghi xong không ra
    // điểm"). Groq đã nhanh (~250ms) & chính xác nên không cần backup webspeech.
    const data = await recordRaw(opts);

    if (engine === 'whisper') {
      let groqErrReason = '';
      // CHẶN ẢO GIÁC TRÊN IM LẶNG: VAD không thấy tiếng nói (mic thu im lặng) → audio
      // trống → KHÔNG gửi Groq (Whisper bịa "Vielen Dank."). Báo trung thực "no-voice".
      if (!data.spoke) {
        return { transcript: '', words: [], pitch: [], spokenMs: data.spokenMs, engine: 'silent (no-voice: mic thu im lặng)' };
      }
      // 1. Groq Whisper (nhanh, chính xác, qua Cloudflare Worker → round-robin 5 keys).
      const groq = await transcribeViaGroq(data.blob, opts.lang2 || 'de');
      if (groq && groq._err) groqErrReason = groq._err; // lưu lý do để debug
      if (groq && !groq._err && groq.text != null) {
        const txt = groq.text.trim();
        if (txt) return { transcript: txt, words: groq.words || [], pitch: [], spokenMs: data.spokenMs, engine: 'groq-whisper (trang)' };
      }
      // 2. Groq thất bại → offline Whisper (Side Panel, model ấm sẵn).
      const result = await transcribeViaSidePanel(data.audio16k, opts);
      if (result && result.text != null) {
        const txt = (result.text || '').trim();
        const V = root.ShadowValidate;
        const bad = !!(txt && V && V.classifyTranscript && V.classifyTranscript(txt) === 'bad');
        return { transcript: txt, words: result.words || [], pitch: [], spokenMs: data.spokenMs, engine: 'whisper:' + (result.modelShort || '?') + ' (trang)', lowConfidence: bad };
      }
      // 3. Tất cả thất bại → trả rỗng; đính kèm lý do Groq để UI hiển thị.
      return { transcript: '', words: [], pitch: [], spokenMs: data.spokenMs, engine: 'silent (groq:' + (groqErrReason || 'empty') + ')' };
    }
    // 'server' engine không hỗ trợ tại trang -> để speech.js fallback về Side Panel.
    throw new Error('page-mic-unsupported-engine');
  }

  function abort() { root.SD.pageMic._abort = true; }
  function finalize() { root.SD.pageMic._finalize = true; }

  // Tự kiểm tra TOÀN BỘ pipeline ghi âm + chấm điểm, trả báo cáo từng bước để gửi support.
  async function selfTest(opts) {
    opts = opts || {};
    const steps = [];
    const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

    // 1. Quyền micro trên trang
    let perm = 'unknown'; try { perm = await permission(); } catch (e) {}
    add('Quyền micro (trang)', perm === 'granted', perm);

    // 2. getUserMedia (mở mic thật)
    let gumOk = false;
    try { await ensure(); gumOk = true; add('Mở micro (getUserMedia)', true, 'OK'); }
    catch (e) { add('Mở micro (getUserMedia)', false, (e && (e.name + ': ' + e.message)) || String(e)); }

    // 3. MediaRecorder codec
    let mime = '';
    try { mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || ''; } catch (e) {}
    add('MediaRecorder codec', !!mime, mime || 'không hỗ trợ');

    // 4. Fetch TRỰC TIẾP /health từ trang — nếu BỊ CHẶN tức là CSP trang chặn (đúng như nghi ngờ)
    try {
      const t0 = Date.now();
      const r = await fetch(WORKER_URL + '/health');
      add('Fetch trực tiếp /health (trang)', r.ok, 'HTTP ' + r.status + ' · ' + (Date.now() - t0) + 'ms');
    } catch (e) { add('Fetch trực tiếp /health (trang)', false, 'BỊ CHẶN bởi CSP trang? ' + ((e && e.message) || e)); }

    // 5. /health QUA BACKGROUND (đường đi thật của Groq sau khi sửa)
    try {
      const r = await new Promise((resolve) => {
        try { chrome.runtime.sendMessage({ sd: 'worker-health' }, (x) => resolve(chrome.runtime.lastError ? { ok: false, err: chrome.runtime.lastError.message } : x)); }
        catch (e) { resolve({ ok: false, err: String(e) }); }
      });
      add('Worker /health qua background', !!(r && r.ok), (r && (r.detail || r.err)) + (r && r.ms != null ? ' · ' + r.ms + 'ms' : ''));
    } catch (e) { add('Worker /health qua background', false, String(e)); }

    // 6. Ghi âm thật (ghi đủ window, không dừng sớm) + đo mức âm + Groq qua background
    if (gumOk && opts.record !== false) {
      try {
        root.SD.pageMic._abort = false; root.SD.pageMic._finalize = false;
        const data = await recordRaw({ maxMs: opts.recMs || 4000, noVadStop: true, vad: {} });
        const peak = data && data.peakRms != null ? data.peakRms : 0;
        // peak < 0.01 ≈ im lặng (sai mic / mic tắt tiếng). > 0.03 = có thu được tiếng.
        const micOk = peak >= 0.02;
        add('Mức âm mic thu được', micOk,
          'đỉnh=' + peak.toFixed(3) + (micOk ? ' (tốt)' : ' (QUÁ NHỎ — kiểm tra thiết bị mic / mic tắt tiếng trong Windows)') +
          ' · ngưỡng=' + (data && data.thresh != null ? data.thresh.toFixed(3) : '?') +
          ' · blob=' + (data && data.blob ? data.blob.size : 0) + 'B');
        const t0 = Date.now();
        const groq = await transcribeViaGroq(data.blob, opts.lang || 'de');
        if (groq && groq._err) add('Groq chấm (qua background)', false, groq._err + ' · ' + (Date.now() - t0) + 'ms');
        else add('Groq chấm (qua background)', !!(groq && (groq.text || '').trim()), 'nghe được: "' + ((groq && groq.text) || '').trim() + '" · ' + (Date.now() - t0) + 'ms');
      } catch (e) { add('Ghi âm + Groq', false, (e && (e.name + ': ' + e.message)) || String(e)); }
      finally { try { release(); } catch (_) {} }
    }
    return { steps, host: location.hostname, ua: navigator.userAgent.slice(0, 60) };
  }

  // Lần đầu cài extension: TỰ hiện hộp thoại xin quyền micro NGAY trên trang (như ảnh
  // "m.youtube.com wants to use microphone"). Chỉ chạy MỘT lần (cờ micOnboardPending do
  // background đặt khi cài), và chỉ khi quyền còn 'prompt' (chưa cấp / chưa chặn) để
  // không làm phiền người đã quyết định. Lấy quyền xong nhả track ngay.
  async function firstRunPrompt() {
    try {
      const d = await new Promise((res) => {
        try { chrome.storage.local.get('micOnboardPending', (x) => res(x || {})); } catch (e) { res({}); }
      });
      if (!d.micOnboardPending) return;
      // Xoá cờ TRƯỚC để dù kết quả thế nào cũng không hỏi lại ở lần mở sau.
      try { chrome.storage.local.remove('micOnboardPending'); } catch (e) {}
      let state = 'prompt'; try { state = await permission(); } catch (e) {}
      if (state === 'granted' || state === 'denied') return; // đã quyết định -> bỏ qua
      await ensure();  // getUserMedia({ audio:true }) -> hộp thoại micro hiện trên trang
      release();       // chỉ cần lấy quyền; Side Panel sẽ tự mở mic khi ghi âm
    } catch (e) {}
  }

  // Side Panel điều khiển trực tiếp (cấp quyền NGAY trên trang, dừng/kết thúc ghi âm).
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (!msg || msg.sd !== 'page-mic') return;
    (async () => {
      try {
        if (msg.action === 'permission') { reply({ ok: true, state: await permission() }); return; }
        if (msg.action === 'ensure') { await ensure(); reply({ ok: true, state: await permission() }); return; }
        if (msg.action === 'abort') { abort(); reply({ ok: true }); return; }
        if (msg.action === 'finalize') { finalize(); reply({ ok: true }); return; }
        if (msg.action === 'selftest') { reply({ ok: true, report: await selfTest(msg.opts || {}) }); return; }
        reply({ ok: false, error: 'unknown-action' });
      } catch (e) { reply({ ok: false, error: (e && e.message) || String(e), name: (e && e.name) || 'Error' }); }
    })();
    return true;
  });

  root.SD.pageMic = { ensure, permission, recognize, release, abort, finalize, firstRunPrompt, _abort: false, _finalize: false };
})(window);
