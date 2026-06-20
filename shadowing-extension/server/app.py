"""
Shadow STT server (FastAPI) — nhận diện giọng nói tiếng Đức bằng Whisper phía server.
Chạy: pip install -r requirements.txt && uvicorn app:app --host 0.0.0.0 --port 8000
Extension gọi POST /transcribe (file WAV) -> {text, words}. CORS mở để gọi từ youtube.com.
"""
import io, os
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI(title="Shadow STT")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_MODEL = None
def model():
    global _MODEL
    if _MODEL is None:
        # faster-whisper: nhẹ + nhanh hơn openai-whisper. WHISPER_MODEL: tiny/base/small/medium
        from faster_whisper import WhisperModel
        size = os.environ.get("WHISPER_MODEL", "base")
        device = os.environ.get("WHISPER_DEVICE", "cpu")
        compute = os.environ.get("WHISPER_COMPUTE", "int8")
        _MODEL = WhisperModel(size, device=device, compute_type=compute)
    return _MODEL

@app.get("/health")
def health():
    return {"ok": True, "model": os.environ.get("WHISPER_MODEL", "base")}

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), lang: str = Form("de")):
    audio = await file.read()
    try:
        segments, info = model().transcribe(io.BytesIO(audio), language=lang, word_timestamps=True, vad_filter=True)
        words, text = [], []
        for seg in segments:
            text.append(seg.text)
            for w in (seg.words or []):
                words.append({"text": w.word.strip(), "startMs": int(w.start * 1000), "endMs": int(w.end * 1000)})
        return {"text": " ".join(text).strip(), "words": words, "engine": "server"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

# --- Chấm phát âm theo ÂM VỊ (wav2vec2 + GOP) — chuẩn hơn Kölner Phonetik -------
# Model espeak đa ngôn ngữ (gồm tiếng Đức): facebook/wav2vec2-lv-60-espeak-cv-ft
_PHO = None
def phoneme_model():
    global _PHO
    if _PHO is None:
        import torch
        from transformers import Wav2Vec2Processor, Wav2Vec2ForCTC
        name = os.environ.get("PHONEME_MODEL", "facebook/wav2vec2-lv-60-espeak-cv-ft")
        proc = Wav2Vec2Processor.from_pretrained(name)
        model = Wav2Vec2ForCTC.from_pretrained(name).eval()
        _PHO = (proc, model, torch)
    return _PHO

def _decode_16k(audio_bytes):
    import io, numpy as np, soundfile as sf
    data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        ratio = 16000 / sr
        idx = np.clip((np.arange(int(len(data) * ratio)) / ratio).astype("int64"), 0, len(data) - 1)
        data = data[idx]
    return data

def _phonemize(text, lang="de"):
    try:
        from phonemizer import phonemize
        code = {"de": "de", "en": "en-us", "fr": "fr-fr", "es": "es", "it": "it"}.get(lang, lang)
        return phonemize(text, language=code, backend="espeak", strip=True, with_stress=False)
    except Exception:
        return ""

def _lev(a, b):
    m, n = len(a), len(b)
    if not m: return n
    if not n: return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[n]

@app.post("/score")
async def score(file: UploadFile = File(...), reference: str = Form(""), lang: str = Form("de")):
    """Tra ve diem phat am theo am vi. GOP xap xi: do khop am vi nghe-duoc vs am vi ky-vong
    + do tin cay trung binh cua CTC posterior (proxy cho do ro rang)."""
    try:
        import torch
        audio = _decode_16k(await file.read())
        proc, model, torch = phoneme_model()
        with torch.no_grad():
            inputs = proc(audio, sampling_rate=16000, return_tensors="pt")
            logits = model(inputs.input_values).logits[0]
        probs = logits.softmax(dim=-1)
        ids = probs.argmax(dim=-1)
        conf = float(probs.max(dim=-1).values.mean()) * 100.0
        heard = proc.tokenizer.decode(ids).strip()
        expected = _phonemize(reference, lang) if reference else ""
        accuracy = None
        if expected:
            a, b = heard.replace(" ", ""), expected.replace(" ", "")
            accuracy = round(max(0.0, 1.0 - _lev(a, b) / max(len(a), len(b), 1)) * 100.0, 1)
        return {
            "phonemes_heard": heard,
            "phonemes_expected": expected,
            "phoneme_accuracy": accuracy,    # 0..100, None neu khong co reference
            "confidence": round(conf, 1),    # 0..100
            "engine": "wav2vec2-gop",
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

# Tuỳ chọn: lấy phụ đề YouTube sạch (cần youtube-transcript-api)
@app.get("/transcript")
def transcript(videoId: str, lang: str = "de"):
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        data = YouTubeTranscriptApi.get_transcript(videoId, languages=[lang, "de", "en"])
        cues = [{"text": d["text"], "startMs": int(d["start"] * 1000), "endMs": int((d["start"] + d["duration"]) * 1000)} for d in data]
        return {"cues": cues}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
