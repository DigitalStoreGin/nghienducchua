/* Microphone and speech recognition live in the extension side panel.
 * This avoids host-page Permissions-Policy restrictions on YouTube/Netflix.
 *
 * Cai tien:
 * - Permission check truoc khi request (navigator.permissions.query)
 * - Huong dan user cu the khi chua co quyen
 * - AbortController cho recording (engine co the cancel)
 * - Adaptive VAD (Voice Activity Detection) voi RMS threshold */
(function (root) {
  'use strict';

  let stream = null;
  let worker = null;
  let levelTimer = null;
  let levelContext = null;
  let onLevel = null;
  let onProgress = null;
  let currentAbort = null;       // AbortController cho recording hien tai
  let currentFinalize = false;   // co: user bam "Toi noi xong" -> dung & cham ngay
  let currentRecognition = null; // Web Speech recognition dang chay (de finalize/abort)
  let whisperReady = null;       // cache: vendor/transformers.min.js co ton tai khong

  function setLevelListener(cb) { onLevel = cb; }
  function setProgressListener(cb) { onProgress = cb; }

  // --- Permission check ---
  async function checkMicPermission() {
    try {
      const result = await navigator.permissions.query({ name: 'microphone' });
      return result.state; // 'granted' | 'denied' | 'prompt'
    } catch (e) { return 'unknown'; }
  }

  async function ensureMic() {
    if (stream && stream.active && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('media-devices-unavailable');

    // Check permission truoc
    const permState = await checkMicPermission();
    if (permState === 'denied') {
      throw Object.assign(new Error('Microphone đã bị chặn. Click 🔒 cạnh thanh địa chỉ → Microphone → Allow, rồi reload trang.'), { name: 'NotAllowedError' });
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    startLevelMeter(stream);
    return stream;
  }

  function startLevelMeter(mediaStream) {
    stopLevelMeter();
    try {
      levelContext = new AudioContext();
      const source = levelContext.createMediaStreamSource(mediaStream);
      const analyser = levelContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        if (onLevel) onLevel(Math.min(1, Math.sqrt(sum / data.length) * 5));
      }, 80);
    } catch (_) {}
  }

  function stopLevelMeter() {
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
    if (levelContext) levelContext.close().catch(() => {});
    levelContext = null;
  }

  function estimatePitch(buf, sampleRate) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.012) return 0;
    const minLag = Math.floor(sampleRate / 500);
    const maxLag = Math.min(Math.floor(sampleRate / 70), buf.length - 1);
    let bestLag = 0, best = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      let corr = 0;
      for (let i = 0; i < buf.length - lag; i += 2) corr += buf[i] * buf[i + lag];
      if (corr > best) { best = corr; bestLag = lag; }
    }
    return bestLag ? sampleRate / bestLag : 0;
  }

  function downsampleTo16k(input, inputRate) {
    if (inputRate === 16000) return input;
    const ratio = inputRate / 16000;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < output.length; i++) {
      const pos = i * ratio, lo = Math.floor(pos), mix = pos - lo;
      output[i] = (input[lo] || 0) * (1 - mix) + (input[lo + 1] || 0) * mix;
    }
    return output;
  }

  async function recordRaw(maxMs, abortSignal, vad) {
    vad = vad || {};
    const minMs = vad.minMs != null ? vad.minMs : 600;                // khong dung truoc nguong nay
    const hangMs = vad.silenceHangMs != null ? vad.silenceHangMs : 900; // im lang bao lau -> dung
    const noSpeechMs = vad.noSpeechMs != null ? vad.noSpeechMs : 4500;   // chua noi gi -> dung som

    const mediaStream = await ensureMic();
    const wantSilero = !!vad.silero && root.SileroVAD;
    let ac;
    try { ac = wantSilero ? new AudioContext({ sampleRate: 16000 }) : new AudioContext(); }
    catch (e) { ac = new AudioContext(); }
    if (ac.state === 'suspended') await ac.resume();
    const source = ac.createMediaStreamSource(mediaStream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    const chunks = [], pitch = [], sample = new Float32Array(analyser.fftSize);
    const started = Date.now();
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) => reject(event.error || new Error('media-recorder-error'));
    });
    recorder.start(200);

    // Abort handler
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
      }, { once: true });
    }

    let silenceMs = 0, spoke = false;

    // --- Silero VAD (neu bat & co model) — endpointing bang AI thay cho RMS ---
    let sileroActive = false, sileroNode = null, sileroSink = null;
    if (wantSilero && ac.sampleRate === 16000) {
      try {
        if (await root.SileroVAD.available()) {
          const detector = await root.SileroVAD.createDetector();
          sileroNode = ac.createScriptProcessor(512, 1, 1);
          sileroSink = ac.createGain(); sileroSink.gain.value = 0; // tranh vong tieng ra loa
          source.connect(sileroNode); sileroNode.connect(sileroSink); sileroSink.connect(ac.destination);
          let busy = false;
          sileroNode.onaudioprocess = (e) => {
            if (busy) return;
            const frame = new Float32Array(e.inputBuffer.getChannelData(0)); // 512 mau @16kHz
            busy = true;
            detector.process(frame).then((p) => {
              busy = false;
              if (p > 0.5) { spoke = true; silenceMs = 0; }
              else if (spoke) { silenceMs += 32; } // 512/16000 ~ 32ms moi frame
            }).catch(() => { busy = false; });
          };
          sileroActive = true;
        }
      } catch (e) { sileroActive = false; }
    }

    // --- VAD THICH NGHI theo RMS (mac dinh / du phong khi khong co Silero).
    //     autoGainControl khuech dai tieng on nen, nen do nen nhieu ~400ms dau roi tu dat nguong. ---
    const FRAME = 50;
    let frames = 0, noiseSum = 0, noiseN = 0, thresh = 0.02;
    const monitor = setInterval(() => {
      analyser.getFloatTimeDomainData(sample);
      let rms = 0;
      for (let i = 0; i < sample.length; i++) rms += sample[i] * sample[i];
      rms = Math.sqrt(rms / sample.length);
      pitch.push(estimatePitch(sample, ac.sampleRate));
      if (sileroActive) return; // Silero dang dieu khien spoke/silenceMs
      frames++;
      const elapsed = frames * FRAME;
      if (elapsed <= 400) {
        noiseSum += rms; noiseN++;
        thresh = Math.min(0.12, Math.max(0.02, (noiseSum / noiseN) * 2.5 + 0.006));
      } else if (rms > thresh) {
        spoke = true; silenceMs = 0;
      } else {
        silenceMs += FRAME;
      }
    }, FRAME);

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (abortSignal && abortSignal.aborted) { clearInterval(timer); resolve(); return; }
        if (currentFinalize) { clearInterval(timer); resolve(); return; }      // user bam "Toi noi xong"
        const elapsed = Date.now() - started;
        if (elapsed >= maxMs) { clearInterval(timer); resolve(); return; }       // tran tho gioi
        if (spoke && silenceMs >= hangMs && elapsed >= minMs) { clearInterval(timer); resolve(); return; } // tu dung sau khi noi xong
        if (!spoke && elapsed >= noSpeechMs) { clearInterval(timer); resolve(); return; }                  // chua noi gi -> dung som
      }, 50);
    });

    const spokenMs = Date.now() - started;
    clearInterval(monitor);
    if (sileroNode) { try { sileroNode.onaudioprocess = null; sileroNode.disconnect(); sileroSink.disconnect(); } catch (e) {} }
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    if (abortSignal && abortSignal.aborted) { await ac.close(); throw new Error('recording-aborted'); }
    if (!chunks.length) { await ac.close(); throw new Error('empty-recording'); }

    const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
    const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
    const audio16k = downsampleTo16k(decoded.getChannelData(0), decoded.sampleRate);
    await ac.close();
    return { audio16k, pitch, spokenMs, spoke };
  }

  async function webSpeech(opts) {
    await ensureMic();
    const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!Recognition) throw new Error('no-webspeech');
    return new Promise((resolve, reject) => {
      const recognition = new Recognition();
      recognition.lang = opts.lang || 'de-DE';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      currentRecognition = recognition; // de finalizeRecording()/abortRecording() dieu khien
      let transcript = '', settled = false;
      const started = Date.now();
      const engineLabel = opts.engineLabel || 'webspeech';
      const cleanup = () => { if (currentRecognition === recognition) currentRecognition = null; };

      // Abort handler (bo qua ket qua)
      if (opts.abortSignal) {
        opts.abortSignal.addEventListener('abort', () => {
          if (!settled) { settled = true; clearTimeout(timeout); cleanup(); try { recognition.abort(); } catch (_) {} resolve({ transcript: '', words: [], pitch: [], spokenMs: 0, engine: engineLabel }); }
        }, { once: true });
      }

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve({ transcript: transcript.trim(), words: [], pitch: [], spokenMs: Date.now() - started, engine: engineLabel });
      };
      recognition.onresult = (event) => {
        transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ');
        if (event.results[event.results.length - 1].isFinal) finish();
      };
      // Tu dung ngay khi nguoi noi ngung (browser-side VAD)
      recognition.onspeechend = () => { try { recognition.stop(); } catch (_) {} };
      recognition.onerror = (event) => {
        if (settled) return;
        const err = event.error || 'unknown';
        // Khong noi gi / bi huy -> coi nhu rong (UI se bao than thien, khong nem loi do)
        if (err === 'no-speech' || err === 'aborted') { finish(); return; }
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error('webspeech:' + err));
      };
      recognition.onend = finish;
      const timeout = setTimeout(() => { try { recognition.stop(); } catch (_) {} }, opts.maxMs || 7000);
      try { recognition.start(); } catch (error) { clearTimeout(timeout); cleanup(); reject(error); }
    });
  }

  // Web Speech chạy SONG SONG lúc ghi âm: bắt cùng câu nói để DỰ PHÒNG cho Whisper.
  // Nếu Whisper rỗng/ảo giác -> dùng ngay kết quả này, KHÔNG bắt khách nói lại.
  function startParallelWebSpeech(opts) {
    const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!Recognition) return null;
    let transcript = '', rec;
    try {
      rec = new Recognition();
      rec.lang = opts.lang || 'de-DE';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let t = '';
        for (let i = 0; i < event.results.length; i++) t += (event.results[i][0] && event.results[i][0].transcript || '') + ' ';
        transcript = t.replace(/\s+/g, ' ').trim();
      };
      rec.onerror = () => {}; // chỉ là dự phòng -> nuốt lỗi (no-speech/aborted…)
      rec.start();
    } catch (_) { return null; }
    return {
      getTranscript: () => transcript.trim(),
      stop: () => { try { rec.stop(); } catch (_) {} try { rec.abort(); } catch (_) {} },
    };
  }

  function encodeWav(f32, sampleRate) {
    const buffer = new ArrayBuffer(44 + f32.length * 2), view = new DataView(buffer);
    const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + f32.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, f32.length * 2, true);
    for (let i = 0, offset = 44; i < f32.length; i++, offset += 2) {
      const value = Math.max(-1, Math.min(1, f32[i]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return buffer;
  }

  async function serverSpeech(opts) {
    const data = await recordRaw(opts.maxMs || 7000, opts.abortSignal, opts.vad);
    const form = new FormData();
    form.append('file', new Blob([encodeWav(data.audio16k, 16000)], { type: 'audio/wav' }), 'recording.wav');
    form.append('lang', opts.lang2 || 'de');
    const url = (opts.serverUrl || 'http://localhost:8000').replace(/\/$/, '') + '/transcribe';
    const response = await fetch(url, { method: 'POST', body: form });
    if (!response.ok) throw new Error('server-http-' + response.status);
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    return { transcript: (result.text || '').trim(), words: result.words || [], pitch: data.pitch, spokenMs: data.spokenMs, engine: 'server' };
  }

  // ── Phát hiện cấu hình máy & chọn model Whisper phù hợp ───────────────
  //  Logic chọn model nằm ở lib/whisper-select.js (nguồn chân lý duy nhất, có test).
  //  Web Speech chỉ là phương án CUỐI khi Whisper không khả dụng.
  const WS = root.WhisperSelect || {
    // Dự phòng nếu lib chưa nạp (không nên xảy ra) — mặc định an toàn 'base'.
    detectHardware: () => ({ mem: navigator.deviceMemory || 4, cores: navigator.hardwareConcurrency || 2, gpu: !!navigator.gpu, coi: !!self.crossOriginIsolated }),
    pickWhisperModel: (_hw, ov) => ({ id: 'Xenova/whisper-' + (ov && ov !== 'auto' ? ov : 'base'), label: 'Base', short: (ov && ov !== 'auto' ? ov : 'base') }),
    pickThreads: () => 1,
  };
  let _hwCache = null;
  function detectHardware() { return (_hwCache = _hwCache || WS.detectHardware()); }
  function pickWhisperModel(override) { return WS.pickWhisperModel(detectHardware(), override); }
  function pickThreads() { return WS.pickThreads(detectHardware()); }
  const TINY = (WS.WHISPER_MODELS && WS.WHISPER_MODELS.tiny) || { id: 'Xenova/whisper-tiny', short: 'tiny' };
  function shortFromId(id) { return String(id || '').replace('Xenova/whisper-', '') || 'base'; }

  // ── Trạng thái nâng cấp dần ──────────────────────────────────────────
  //  activeModelId : model ĐÃ sẵn sàng trong worker -> dùng để phiên dịch NGAY.
  //  targetModelId : model phù hợp máy (đích nâng cấp).
  //  _pendingUpgrade: chờ model nhỏ 'ready' rồi mới nạp đích Ở NỀN (tránh tải song song nặng).
  let activeModelId = null;
  let targetModelId = null;
  let _pendingUpgrade = null;
  let _warmupStarted = false;

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(chrome.runtime.getURL('whisper-worker.js'), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'progress' && onProgress) onProgress(msg.status, msg.progress);
      // Model nhỏ đã sẵn sàng -> khách dùng được NGAY; nếu có đích, nạp đích Ở NỀN.
      if (msg.type === 'ready') {
        activeModelId = msg.model;
        if (_pendingUpgrade && _pendingUpgrade.id !== msg.model) {
          try { worker.postMessage({ type: 'upgrade', model: _pendingUpgrade.id, numThreads: _pendingUpgrade.threads }); } catch (_) {}
        }
        _pendingUpgrade = null;
      }
      // Model phù hợp máy đã nạp xong (ở nền) -> từ giờ phiên dịch dùng model mạnh hơn.
      if (msg.type === 'upgraded') activeModelId = msg.model;
    });
    return worker;
  }

  // Nạp sẵn model để lần ghi âm đầu không phải chờ.
  //  Chế độ AUTO: nạp TINY trước (nhẹ ~75MB, sẵn sàng nhanh) cho khách dùng ngay,
  //  rồi tự nâng cấp lên model PHÙ HỢP MÁY ở nền. Chọn tay (override) -> nạp đúng model đó.
  async function warmupWhisper(override) {
    if (!(await isWhisperAvailable())) return false;
    const target = pickWhisperModel(override);
    const threads = pickThreads();
    targetModelId = target.id;
    _warmupStarted = true;
    try {
      const w = getWorker();
      const manual = override && override !== 'auto';
      if (manual || target.id === TINY.id) {
        // Khách chọn tay, hoặc máy yếu chỉ hợp tiny -> nạp đúng 1 model.
        activeModelId = activeModelId || TINY.id; // tạm dùng tiny tới khi 'ready'
        _pendingUpgrade = null;
        w.postMessage({ type: 'warmup', model: target.id, numThreads: threads });
      } else {
        // AUTO: tiny trước, đích phù hợp máy nâng cấp ở nền.
        _pendingUpgrade = { id: target.id, threads };
        w.postMessage({ type: 'warmup', model: TINY.id, numThreads: threads });
      }
      return true;
    } catch (_) { return false; }
  }

  // Thông tin model cho UI: máy, model đích, model đang dùng (đã sẵn sàng).
  function whisperStatus(override) {
    const hw = detectHardware();
    const target = pickWhisperModel(override);
    return {
      hw,
      target: target.short,
      active: activeModelId ? shortFromId(activeModelId) : null,
      upgrading: !!(activeModelId && targetModelId && activeModelId !== targetModelId),
    };
  }

  // Whisper co san khong? (vendor/transformers.min.js da duoc nhung qua build-release chua)
  async function isWhisperAvailable() {
    if (whisperReady != null) return whisperReady;
    try {
      const r = await fetch(chrome.runtime.getURL('vendor/transformers.min.js'), { method: 'HEAD' });
      whisperReady = !!(r && r.ok);
    } catch (_) { whisperReady = false; }
    return whisperReady;
  }

  async function whisperSpeech(opts) {
    // Whisper chua cai (thieu vendor/) -> tu fallback sang Web Speech ngay,
    // khong bat user noi 12s roi moi bao loi.
    if (!(await isWhisperAvailable())) {
      const r = await webSpeech(Object.assign({}, opts, { engineLabel: 'webspeech (Whisper chưa cài)' }));
      r.fallback = true;
      return r;
    }
    // Chọn tay -> đúng model đó. AUTO -> KHÔNG ghim model (gửi undefined) để worker
    // dùng pipe HIỆN TẠI (tiny lúc đầu, tự lên model phù hợp máy khi nạp xong ở nền) —
    // tránh ghim nhầm model cũ làm worker nạp lại / tải song song 2 model nặng.
    const threads = pickThreads();
    const manual = !!(opts.whisperModel && opts.whisperModel !== 'auto');
    let transcribeModel; // undefined cho AUTO
    if (manual) transcribeModel = pickWhisperModel(opts.whisperModel).id;
    else if (!activeModelId && !_warmupStarted) { try { warmupWhisper('auto'); } catch (_) {} }
    const labelModel = transcribeModel || activeModelId || TINY.id;
    // Bắt Web Speech SONG SONG (dự phòng không cần nói lại). Lấy kết quả sau khi ghi xong.
    const parallel = startParallelWebSpeech(opts);
    let webspeechBackup = '';
    const data = await recordRaw(opts.maxMs || 7000, opts.abortSignal, opts.vad), id = crypto.randomUUID();
    if (parallel) {
      try { await new Promise((r) => setTimeout(r, 250)); webspeechBackup = parallel.getTranscript(); } catch (_) {}
      parallel.stop();
    }
    try {
      const result = await new Promise((resolve, reject) => {
        const w = getWorker();
        let done = false;
        const cleanup = () => {
          try { w.removeEventListener('message', listener); } catch (_) {}
          clearTimeout(to);
          if (opts.abortSignal) { try { opts.abortSignal.removeEventListener('abort', onAbort); } catch (_) {} }
        };
        const listener = (event) => {
          const msg = event.data || {};
          if (msg.id !== id || done) return;
          done = true; cleanup();
          if (msg.type === 'result') resolve(msg); else reject(new Error(msg.error || 'whisper-error'));
        };
        const onAbort = () => { if (done) return; done = true; cleanup(); reject(new Error('recording-aborted')); };
        // Lưới an toàn: worker treo/OOM -> không kẹt vĩnh viễn (rộng rãi cho lần tải model đầu).
        const to = setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('whisper-timeout')); }, 120000);
        w.addEventListener('message', listener);
        if (opts.abortSignal) opts.abortSignal.addEventListener('abort', onAbort, { once: true });
        w.postMessage(
          { type: 'transcribe', id, audio: data.audio16k, sampleRate: 16000, model: transcribeModel, numThreads: threads, language: opts.language || 'german' },
          [data.audio16k.buffer]
        );
      });
      activeModelId = result.model || activeModelId; // worker báo model thực tế đã dùng
      const txt = (result.text || '').trim();
      const V = root.ShadowValidate;
      const bad = !!(txt && V && V.classifyTranscript && V.classifyTranscript(txt) === 'bad');
      // Whisper rỗng (mà khách CÓ nói) hoặc "ảo giác" -> dùng Web Speech bắt SONG SONG,
      // KHÔNG bắt khách nói lại. Rỗng + backup rỗng = khách chưa nói -> trả rỗng.
      if ((!txt || bad) && webspeechBackup) {
        return { transcript: webspeechBackup, words: [], pitch: data.pitch, spokenMs: data.spokenMs, engine: 'webspeech↔whisper', fallback: true, whisperRejected: txt.slice(0, 80) };
      }
      return { transcript: txt, words: result.words || [], pitch: data.pitch, spokenMs: data.spokenMs, engine: 'whisper:' + shortFromId(result.model || labelModel), lowConfidence: bad };
    } catch (err) {
      if (err && /recording-aborted/.test(String(err.message || err))) throw err; // user bấm Dừng -> tôn trọng
      // Whisper lỗi lúc chạy (hiếm). Có Web Speech bắt song song -> dùng luôn (không nói lại).
      if (webspeechBackup) {
        return { transcript: webspeechBackup, words: [], pitch: data.pitch, spokenMs: data.spokenMs, engine: 'webspeech (Whisper lỗi)', fallback: true, whisperError: String(err.message || err) };
      }
      // Không có backup -> phương án cuối: ghi âm lại bằng Web Speech để không kẹt.
      const r = await webSpeech(Object.assign({}, opts, { engineLabel: 'webspeech (Whisper lỗi)' }));
      r.fallback = true; r.whisperError = String(err.message || err);
      return r;
    }
  }

  // base64(PCM Int16) -> Float32 [-1,1] (giải mã audio do trang YouTube gửi sang).
  function b64Int16ToF32(b64) {
    const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer), n = (len / 2) | 0, f32 = new Float32Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 2) { const s = dv.getInt16(o, true); f32[i] = s < 0 ? s / 0x8000 : s / 0x7fff; }
    return f32;
  }

  // Chấm Whisper trên audio 16k CÓ SẴN (dùng khi ghi âm diễn ra ngay trên trang YouTube).
  // Model/worker vẫn ở Side Panel; trang chỉ gửi audio sang đây để chấm.
  async function transcribeAudio16k(audio16k, opts) {
    opts = opts || {};
    if (!(await isWhisperAvailable())) throw new Error('whisper-unavailable');
    const threads = pickThreads();
    const manual = !!(opts.whisperModel && opts.whisperModel !== 'auto');
    let transcribeModel; // undefined cho AUTO (dùng pipe hiện tại của worker)
    if (manual) transcribeModel = pickWhisperModel(opts.whisperModel).id;
    else if (!activeModelId && !_warmupStarted) { try { warmupWhisper('auto'); } catch (_) {} }
    const id = crypto.randomUUID();
    const result = await new Promise((resolve, reject) => {
      const w = getWorker();
      let done = false;
      const cleanup = () => { try { w.removeEventListener('message', listener); } catch (_) {} clearTimeout(to); };
      const listener = (event) => { const m = event.data || {}; if (m.id !== id || done) return; done = true; cleanup(); if (m.type === 'result') resolve(m); else reject(new Error(m.error || 'whisper-error')); };
      // Fallback path (Groq là chính). Page-mic đã tự cắt ở 15s nên giới hạn 20s là đủ —
      // tránh worker chạy lê thê 120s sau khi phía trang đã bỏ qua, gây tốn tài nguyên.
      const to = setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('whisper-timeout')); }, 20000);
      w.addEventListener('message', listener);
      w.postMessage({ type: 'transcribe', id, audio: audio16k, sampleRate: 16000, model: transcribeModel, numThreads: threads, language: opts.language || 'german' }, [audio16k.buffer]);
    });
    activeModelId = result.model || activeModelId;
    return { text: (result.text || '').trim(), words: result.words || [], model: result.model, modelShort: shortFromId(result.model || transcribeModel || activeModelId || TINY.id) };
  }

  async function recognize(opts) {
    // Create AbortController cho recording nay
    const ac = new AbortController();
    currentAbort = ac;
    currentFinalize = false;
    opts = Object.assign({}, opts, { abortSignal: ac.signal });

    try {
      const engine = opts.engine || 'webspeech';
      if (engine === 'server') return await serverSpeech(opts);
      if (engine === 'whisper') return await whisperSpeech(opts);
      return await webSpeech(opts);
    } finally {
      if (currentAbort === ac) currentAbort = null;
      currentFinalize = false;
      currentRecognition = null;
    }
  }

  // Huy ghi am, BO QUA ket qua (nut "Dung")
  function abortRecording() {
    if (currentRecognition) { try { currentRecognition.abort(); } catch (e) {} }
    if (currentAbort) { try { currentAbort.abort(); } catch (e) {} currentAbort = null; }
  }

  // Dung ghi am NGAY nhung VAN cham diem phan da noi (nut "Toi noi xong")
  function finalizeRecording() {
    currentFinalize = true;
    if (currentRecognition) { try { currentRecognition.stop(); } catch (e) {} }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.sd !== 'mic-service') return;
    (async () => {
      try {
        if (msg.action === 'ensure') { await ensureMic(); reply({ ok: true }); return; }
        if (msg.action === 'permission') {
          const state = await checkMicPermission();
          reply({ ok: true, state }); return;
        }
        if (msg.action === 'recognize') { reply({ ok: true, result: await recognize(msg.opts || {}) }); return; }
        if (msg.action === 'transcribeAudio') {
          // Audio ghi ngay trên trang YouTube gửi sang -> chỉ chấm Whisper tại đây.
          const f32 = b64Int16ToF32(msg.audioB64 || '');
          reply({ ok: true, result: await transcribeAudio16k(f32, msg.opts || {}) }); return;
        }
        if (msg.action === 'warmup') { const ok = await warmupWhisper((msg.opts || {}).whisperModel); reply({ ok: true, started: ok }); return; }
        if (msg.action === 'hardware') { reply({ ok: true, hw: detectHardware(), model: pickWhisperModel((msg.opts || {}).whisperModel), status: whisperStatus((msg.opts || {}).whisperModel) }); return; }
        if (msg.action === 'abort') { abortRecording(); reply({ ok: true }); return; }
        if (msg.action === 'finalize') { finalizeRecording(); reply({ ok: true }); return; }
        reply({ ok: false, error: 'unknown-action' });
      } catch (error) { reply({ ok: false, error: error.message || String(error), name: error.name || 'Error' }); }
    })();
    return true;
  });

  root.ShadowMic = { ensureMic, recognize, transcribeAudio16k, abortRecording, finalizeRecording, isWhisperAvailable, checkMicPermission, setLevelListener, setProgressListener, detectHardware, pickWhisperModel, warmupWhisper, whisperStatus };
})(window);
