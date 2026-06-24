/* Shadow engine: may trang thai luyen + live caption capture.
 * Rebuild theo pattern Trancy: explicit states voi guard conditions.
 *
 * States: idle -> playing -> waitingMic -> recording -> scoring -> feedback -> (repeat | next)
 *
 * Cai tien:
 * - waitUntil: phat hien video paused, ad, hard timeout 15s
 * - waitingMic: 300ms im lang truoc khi bat dau ghi (tranh thu tieng video)
 * - Ad handling: pause workflow khi YouTube chieu quang cao
 * - recordAndScore: fallback khi STT tra ve empty
 * - stop(): cancel recognition neu dang chay */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  const V = () => root.SD.video;

  const engine = {
    sentences: [], idx: -1, rep: 0, settings: null, busy: false,
    queue: null, qpos: 0, current: 0, loopOne: false, playing: false,
    enabled: true,     // master ON/OFF — OFF: khong tu dung cuoi cau, khong lap, khong overlay
    on: {}, runId: 0, // callbacks: state, feedback, highlight, sentences
    _abortRec: null,   // AbortController cho recording

    emit(name, data) { (this.on[name] || []).forEach((cb) => { try { cb(data); } catch (e) {} }); },
    listen(name, cb) { (this.on[name] = this.on[name] || []).push(cb); },

    setSentences(s) { this.sentences = s || []; this.emit('sentences', this.sentences); },
    setSettings(s) { this.settings = s; if (s) this.enabled = s.extEnabled !== false; },
    setEnabled(b) { this.enabled = !!b; if (!b) this.loopOne = false; },

    jumpTo(i) {
      const s = this.sentences[i]; if (!s) return;
      const off = (this.settings?.offsetMs || 0) / 1000;
      V().setRate(this.settings?.rate || 1);
      V().seekTo(s.startMs / 1000 + off);
      V().play().catch(() => {});
    },

    // --- Dieu khien theo cau (segment-locked) cho thanh dieu khien duoi ---
    off() { return (this.settings?.offsetMs || 0) / 1000; },

    setCurrent(i) {
      if (i < 0 || i >= this.sentences.length) return;
      this.current = i;
      this.emit('current', { idx: i, total: this.sentences.length, sentence: this.sentences[i] });
    },

    selectSegment(i, opts) {
      opts = opts || {};
      if (i < 0 || i >= this.sentences.length) return;
      this.queue = null; this.current = i;
      // Chong "snap-back": sau khi tua, playhead can vai chuc ms de cap nhat. Trong
      // khoang nay monitor co the thay timestamp CU -> nhay ve cau cu. Khoa lai.
      this._seekGuardUntil = Date.now() + 500;
      this.setCurrent(i);
      const s = this.sentences[i]; V().setRate(this.settings?.rate || 1);
      V().seekTo(s.startMs / 1000 + this.off());
      if (opts.play !== false) {
        V().play().catch(() => {});
        this.playing = true;
      } else {
        V().pause(); this.playing = false;
      }
      this.emit('playstate', { playing: this.playing });
    },

    nextSeg() { this.selectSegment(Math.min(this.current + 1, this.sentences.length - 1)); },
    prevSeg() { this.selectSegment(Math.max(this.current - 1, 0)); },

    togglePlay() {
      if (V().el && V().el.paused) {
        V().play().catch(() => {});
        this.playing = true;
      } else {
        V().pause(); this.playing = false;
      }
      this.emit('playstate', { playing: this.playing });
    },

    toggleLoop() {
      this.loopOne = !this.loopOne;
      this.emit('loop', this.loopOne);
      // Bật loop -> tua về đầu câu hiện tại & phát NGAY để nghe vòng lặp liền (monitor
      // sẽ tự tua lại ở cuối câu). Trước đây chỉ chờ monitor nên sau auto-pause như "chết".
      if (this.loopOne) this.selectSegment(this.current, { play: true });
      return this.loopOne;
    },

    // Phát lại đúng đoạn video của 1 câu (KHÔNG TTS) — dùng cho nút "Nghe".
    listenSeg(i) {
      const idx = (i == null) ? this.current : i;
      try { speechSynthesis.cancel(); } catch (e) {}
      this.selectSegment(idx, { play: true });
    },

    async shadow(i) {
      // Preempt: neu dang ban (vd lan cham truoc treo), huy no roi bat dau lai
      // -> tranh truong hop bam "Luyen cau" khong phan hoi gi.
      if (this.busy) { this.runId++; this.busy = false; }
      this.busy = true; this.idx = i; this.rep = 0;
      this.setCurrent(i); // emit 'current' -> Side Panel đồng bộ đúng câu đang luyện
      const runId = ++this.runId;
      await this.runRep(runId);
    },

    shadowSingle(i) { this.queue = null; this.qpos = 0; this.shadow(i); },
    shadowList(indices) { if (!indices || !indices.length) return; this.queue = indices.slice(); this.qpos = 0; this.shadow(this.queue[0]); },

    stop() {
      this.runId++;
      this.queue = null;
      this.busy = false;
      // Cancel ongoing recording
      if (this._abortRec) { try { this._abortRec.abort(); } catch (e) {} this._abortRec = null; }
      try { V().pause(); } catch (e) {}
      this.emit('state', { state: 'idle' });
    },

    async runRep(runId) {
      runId = runId == null ? this.runId : runId;
      const s = this.sentences[this.idx]; if (!s) { this.busy = false; return; }
      const off = (this.settings?.offsetMs || 0) / 1000;
      const startSec = s.startMs / 1000 + off, endSec = s.endMs / 1000 + off;

      // --- State: playing ---
      this.emit('state', { state: 'playing', idx: this.idx, rep: this.rep });
      V().setRate(this.settings?.rate || 1);
      V().seekTo(startSec);

      // Cho quang cao het (neu co)
      await this.waitForAd(runId);
      if (runId !== this.runId || !this.busy) return;

      // Play video
      try { await V().play(); } catch (e) { /* Autoplay blocked — continue anyway */ }

      const reachedEnd = await this.waitUntil(endSec, runId);
      if (!reachedEnd || runId !== this.runId || !this.busy) return;
      V().pause();

      // --- State: waitingMic (300ms im lang truoc khi ghi) ---
      this.emit('state', { state: 'paused', idx: this.idx, rep: this.rep });

      if (this.settings?.autoRecord) {
        // 800ms im lặng: cho echo video tắt hẳn trước khi VAD đo ngưỡng nền.
        await this.delay(800, runId);
        if (runId !== this.runId || !this.busy) return;
        await this.recordAndScore(s, endSec - startSec, runId);
      } else {
        this.busy = false;
        this.emit('state', { state: 'idle', idx: this.idx });
      }
    },

    // Giữ video DỪNG trong ms (watchdog mỗi 150ms) khi Side Panel đang ghi âm.
    holdPause(ms) {
      try { V().pause(); } catch (e) {}
      this.releasePause();
      this._holdTimer = setInterval(() => {
        try { const v = V().el; if (v && !v.paused) v.pause(); } catch (e) {}
      }, 150);
      this._holdStop = setTimeout(() => { this.releasePause(); }, ms || 9000);
    },
    releasePause() {
      if (this._holdTimer) { clearInterval(this._holdTimer); this._holdTimer = null; }
      if (this._holdStop) { clearTimeout(this._holdStop); this._holdStop = null; }
    },

    async recordOnlyAt(i) {
      if (this.busy) { this.runId++; this.busy = false; }
      this.busy = true; this.idx = i; this.rep = 0;
      this._recordOnly = true; // skip runRep retry — user pressed Chấm điểm, not shadow
      this.setCurrent(i);
      const runId = ++this.runId;
      const s = this.sentences[i]; if (!s) { this.busy = false; this._recordOnly = false; return; }
      try { V().pause(); } catch (e) {}
      await this.recordAndScore(s, (s.endMs - s.startMs) / 1000, runId);
      this._recordOnly = false;
    },

    async recordAndScore(s, refSec, runId) {
      const recordOnly = !!this._recordOnly;
      // --- State: recording ---
      this.emit('state', { state: 'recording', idx: this.idx, rep: this.rep });
      // Cap 7s: đủ cho 1 câu, không để "Listening…" kéo dài như treo. VAD tự dừng sớm
      // khi người dùng ngừng nói; nút "⏹ Dừng & chấm" cho dừng thủ công bất cứ lúc nào.
      const maxMs = Math.min(7000, Math.max(2500, Math.round(refSec * 1000 * 1.5 + 1000)));
      // GIỮ video DỪNG suốt lúc ghi âm: chống tiếng video lẫn vào mic (echo) gây
      // "Nothing heard"/chấm sai. Watchdog pause lại mỗi 150ms nếu YouTube tự phát.
      try { V().pause(); } catch (e) {}
      const keepPaused = setInterval(() => {
        try { const v = V().el; if (v && !v.paused) v.pause(); } catch (e) {}
      }, 150);
      let res;
      try {
        const LANG = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ru: 'ru-RU', nl: 'nl-NL' };
        const tgt = this.settings?.targetLang || 'de';
        const recPromise = root.SD.speech.recognize({
          maxMs, engine: this.settings?.engine || 'webspeech',
          whisperModel: this.settings?.whisperModel || 'auto',
          lang: LANG[tgt] || (tgt + '-' + tgt.toUpperCase()),
          lang2: tgt,
          serverUrl: this.settings?.serverUrl || 'http://localhost:8000',
          vad: { silero: !!this.settings?.useSileroVad },
        });
        // Guard cho TOÀN BỘ: maxMs (ghi) + ~13s (Groq qua background) + buffer.
        // Không cần dài như trước vì đã bỏ Web Speech song song (hết treo getUserMedia).
        const guardMs = maxMs + 16000;
        res = await Promise.race([
          recPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('score-timeout')), guardMs)),
        ]);
      } catch (e) { res = { error: 'rec:' + (e.message || e) }; }
      finally { clearInterval(keepPaused); }
      if (runId !== this.runId || !this.busy) return;

      // Báo trạng thái "đang xử lý" sau khi ghi xong, trước khi có kết quả.
      this.emit('state', { state: 'transcribing', idx: this.idx });

      // Error handling
      if (!res || res.error) {
        this.emit('feedback', { error: (res && res.error) || 'unknown' });
        this.busy = false; this._recordOnly = false;
        this.emit('state', { state: 'idle' }); return;
      }

      // Empty transcript (không nghe thấy gì)
      if (!res.transcript || res.transcript.trim() === '') {
        this.emit('feedback', { error: 'empty-transcript', engine: res.engine });
        if (recordOnly) {
          // "Chấm điểm" — không phát lại audio gốc, chỉ hiện lỗi cho user biết.
          this.busy = false; this._recordOnly = false;
          this.emit('state', { state: 'idle', idx: this.idx });
        } else {
          this.rep++;
          if (this.rep < (this.settings?.repeat || 3)) {
            setTimeout(() => { if (runId === this.runId && this.busy) this.runRep(runId); }, 900);
          } else {
            this.busy = false;
            this.advanceToNext(runId);
          }
        }
        return;
      }

      // --- State: scoring ---
      this.emit('state', { state: 'scoring', idx: this.idx, rep: this.rep });
      const score = root.SD.phonetic.analyze(s.text, res.transcript || '', {
        lang: this.settings?.targetLang || 'de',
        pitch: res.pitch || [], spokenMs: res.spokenMs, refMs: (s.endMs - s.startMs),
      });
      score.engine = res.engine;
      score.lowConfidence = !!res.lowConfidence;
      this.emit('feedback', { score, sentence: s, rep: this.rep });
      root.SD.storage.addAttempt({
        text: s.text, transcript: res.transcript,
        pronunciation: score.pronunciation, fluency: score.fluency,
        intonation: score.intonation, overall: score.overall, engine: res.engine,
      });

      if (recordOnly) {
        // "Chấm điểm" — chỉ chấm 1 lần, không tiếp tục loop shadow.
        this.busy = false; this._recordOnly = false;
        this.emit('state', { state: 'idle', idx: this.idx });
      } else {
        this.rep++;
        if (this.rep < (this.settings?.repeat || 3)) {
          setTimeout(() => { if (runId === this.runId && this.busy) this.runRep(runId); }, 900);
        } else {
          this.busy = false;
          this.advanceToNext(runId);
        }
      }
    },

    advanceToNext(runId) {
      let nextIdx = -1;
      if (this.queue) {
        this.qpos++;
        if (this.qpos < this.queue.length) nextIdx = this.queue[this.qpos];
        else this.queue = null;
      } else if (this.settings?.autoNext && this.idx + 1 < this.sentences.length) {
        nextIdx = this.idx + 1;
      }
      if (nextIdx >= 0) setTimeout(() => this.shadow(nextIdx), 700);
      else this.emit('state', { state: 'idle' });
    },

    // --- waitUntil: cho video chay den endSec voi guard conditions ---
    waitUntil(endSec, runId) {
      return new Promise((resolve) => {
        const started = Date.now();
        let pausedSince = 0;
        // Hard timeout = max(8s, thời gian đến endSec × 2 + 3s). Đảm bảo không bao giờ
        // chạy quá 2 lần độ dài câu — nếu xảy ra thì timestamp sai hoặc video đứng.
        const v0 = V().el;
        const remaining = v0 ? Math.max(0, endSec - v0.currentTime) : (endSec || 5);
        const hardMs = Math.max(8000, Math.round(remaining * 2000 + 3000));
        const t = setInterval(() => {
          // Guard: runId thay doi hoac stop
          if (runId !== this.runId || !this.busy) { clearInterval(t); resolve(false); return; }
          // Guard: hard timeout
          if (Date.now() - started > hardMs) { clearInterval(t); resolve(true); return; }
          // Guard: video element chua san sang
          if (!V().isReady()) return;

          const ct = V().getCurrentTime();
          const v = V().el;

          // Thanh cong: da chay den endSec
          if (ct >= endSec) { clearInterval(t); resolve(true); return; }
          // Video ket thuc
          if (v && v.ended) { clearInterval(t); resolve(true); return; }

          // YouTube ad: tam dung workflow, cho ad het
          if (V().isAdPlaying()) {
            pausedSince = 0; // reset pause counter khi co ad
            return;
          }

          // Video bi pause (khong phai do ad): cho 800ms roi tiep tuc
          if (v && v.paused) {
            if (!pausedSince) pausedSince = Date.now();
            else if (Date.now() - pausedSince > 800) { clearInterval(t); resolve(true); return; }
          } else {
            pausedSince = 0;
          }
        }, 60);
      });
    },

    // --- waitForAd: cho YouTube ad ket thuc ---
    waitForAd(runId) {
      return new Promise((resolve) => {
        if (!V().isAdPlaying()) { resolve(); return; }
        this.emit('state', { state: 'ad', idx: this.idx });
        const t = setInterval(() => {
          if (runId !== this.runId || !this.busy) { clearInterval(t); resolve(); return; }
          if (!V().isAdPlaying()) { clearInterval(t); resolve(); }
        }, 500);
        // Ad timeout: khong cho qua 120s
        setTimeout(() => { clearInterval(t); resolve(); }, 120000);
      });
    },

    // Delay helper (cancellable)
    delay(ms, runId) {
      return new Promise((resolve) => {
        setTimeout(() => { resolve(runId === this.runId && this.busy); }, ms);
      });
    },

    // --- Monitor: tu dung cuoi cau / lap 1 cau / cap nhat cau hien tai theo playhead ---
    startMonitor() {
      setInterval(() => {
        if (this.busy || !V().isReady()) return;
        const v = V().el;
        if (!v) return;
        const tMs = (v.currentTime - this.off()) * 1000;
        // cap nhat current theo playhead khi dang phat tu do — TRU khi vua tua (seek guard)
        if (Date.now() >= (this._seekGuardUntil || 0)) {
          const i = this.sentences.findIndex((s) => tMs >= s.startMs - 40 && tMs <= s.endMs);
          if (i >= 0 && i !== this.current && !v.paused) {
            this.current = i;
            this.emit('current', { idx: i, total: this.sentences.length, sentence: this.sentences[i] });
          }
        }
        this.emit('highlight', this.current);
        // auto-pause / loop tai cuoi cau hien tai — CHI khi extension dang BAT (master ON)
        const cur = this.sentences[this.current];
        if (this.enabled && cur && !v.paused) {
          const endSec = cur.endMs / 1000 + this.off();
          if (v.currentTime >= endSec - 0.03) {
            if (this.loopOne) { V().seekTo(cur.startMs / 1000 + this.off()); }
            else if (this.settings?.segPause !== false) {
              V().pause(); this.playing = false; this.emit('playstate', { playing: false });
            }
          }
        }
        const pl = !v.paused; if (pl !== this.playing) { this.playing = pl; this.emit('playstate', { playing: pl }); }
      }, 120);
    },
    startHighlightLoop() { this.startMonitor(); },
  };

  // --- Live caption capture (du phong khi intercept that bai) ---
  const live = {
    obs: null, cues: [], running: false,
    selectors: ['.ytp-caption-segment', '.player-timedtext-text-container', '.caption-window'],
    start() {
      if (this.running) return; this.running = true; this.cues = [];
      const grab = () => {
        let txt = '';
        for (const sel of this.selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length) { txt = Array.from(els).map((e) => e.textContent).join(' ').trim(); if (txt) break; }
        }
        if (txt) {
          const t = Math.round(V().getCurrentTime() * 1000);
          const last = this.cues[this.cues.length - 1];
          if (!last || last.text !== txt) this.cues.push({ startMs: t, endMs: t + 2500, text: txt });
          else last.endMs = t + 2500;
        }
      };
      this.timer = setInterval(grab, 250);
    },
    // Netflix DOM fallback: nhan text tu MutationObserver
    addDomCue(txt) {
      if (!this.running) return;
      const t = Math.round(V().getCurrentTime() * 1000);
      const last = this.cues[this.cues.length - 1];
      if (!last || last.text !== txt) this.cues.push({ startMs: t, endMs: t + 2500, text: txt });
      else last.endMs = t + 2500;
    },
    stop() {
      this.running = false; clearInterval(this.timer);
      const merged = root.SD.parsers.mergeIntoSentences(this.cues);
      engine.setSentences(merged); return merged;
    },
  };

  engine.live = live;
  root.SD.engine = engine;
})(window);
