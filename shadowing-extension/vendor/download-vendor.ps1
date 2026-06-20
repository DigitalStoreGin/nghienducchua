$ErrorActionPreference = "Stop"
$V = "2.17.2"
$B = "https://cdn.jsdelivr.net/npm/@xenova/transformers@$V/dist"
Write-Host "Tai transformers.min.js ..."
Invoke-WebRequest "$B/transformers.min.js" -OutFile "transformers.min.js"
Write-Host "Tai onnxruntime-web wasm ..."
foreach ($f in @("ort-wasm.wasm","ort-wasm-simd.wasm","ort-wasm-threaded.wasm","ort-wasm-simd-threaded.wasm")) {
  try { Invoke-WebRequest "$B/$f" -OutFile $f } catch { Write-Host "  (bo qua $f)" }
}

# --- (Tuy chon) Silero VAD: onnxruntime-web standalone + model. Bo qua neu khong dung. ---
$ORT = "1.19.2"
Write-Host "Tai Silero VAD (ort.min.js + model) ..."
try { Invoke-WebRequest "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT/dist/ort.min.js" -OutFile "ort.min.js" } catch { Write-Host "  (bo qua ort.min.js)" }
foreach ($f in @("ort-wasm-simd-threaded.wasm","ort-wasm-simd-threaded.jsep.wasm")) {
  try { Invoke-WebRequest "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT/dist/$f" -OutFile $f } catch { Write-Host "  (bo qua $f)" }
}
try { Invoke-WebRequest "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/silero_vad_v5.onnx" -OutFile "silero_vad_v5.onnx" } catch { Write-Host "  (bo qua silero_vad_v5.onnx)" }

Write-Host "Xong. Reload extension trong chrome://extensions."
