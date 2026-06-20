#!/usr/bin/env bash
set -e
V=2.17.2
B="https://cdn.jsdelivr.net/npm/@xenova/transformers@${V}/dist"
echo "Tai transformers.min.js ..."
curl -fL "$B/transformers.min.js" -o transformers.min.js
echo "Tai onnxruntime-web wasm ..."
for f in ort-wasm.wasm ort-wasm-simd.wasm ort-wasm-threaded.wasm ort-wasm-simd-threaded.wasm; do
  curl -fL "$B/$f" -o "$f" || echo "  (bo qua $f neu khong co)"
done

# --- (Tuy chon) Silero VAD: onnxruntime-web standalone + model. Bo qua neu khong dung. ---
ORT=1.19.2
echo "Tai Silero VAD (ort.min.js + model) ..."
curl -fL "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort.min.js" -o ort.min.js || echo "  (bo qua ort.min.js)"
for f in ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.jsep.wasm; do
  curl -fL "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/$f" -o "$f" || echo "  (bo qua $f)"
done
curl -fL "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/silero_vad_v5.onnx" -o silero_vad_v5.onnx || echo "  (bo qua silero_vad_v5.onnx)"

echo "Xong. Reload extension trong chrome://extensions."
