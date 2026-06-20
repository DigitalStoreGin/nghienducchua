# vendor/ — thư viện chạy Whisper cục bộ (transformers.js + onnxruntime WASM)

✅ **ĐÃ NHÚNG SẴN** — các file dưới đây đã có trong repo, bạn KHÔNG cần làm gì thêm.
Chỉ cần load extension là engine Whisper chạy được ngay.

- `transformers.min.js`  (thư viện @xenova/transformers 2.17.2) — đã có
- các file `*.wasm` của onnxruntime-web (ort-wasm*.wasm) — đã có

> Model Whisper (tiny/base/small) tự tải từ HuggingFace lần đầu chấm điểm rồi được
> browser cache. Kích thước model được CHỌN TỰ ĐỘNG theo RAM/CPU của máy
> (4GB→tiny/base, 8GB→small). Xem `mic-service.js` → `pickWhisperModel()`.

## Cách lấy lại / cập nhật (nếu cần — đã có sẵn nên thường không cần)

**Windows (PowerShell):** chuột phải `download-vendor.ps1` → Run with PowerShell
hoặc trong thư mục này chạy:

    powershell -ExecutionPolicy Bypass -File download-vendor.ps1

**macOS/Linux (bash):**

    bash download-vendor.sh

Cả hai tải từ jsDelivr (https://cdn.jsdelivr.net). Sau khi xong, thư mục này
phải có `transformers.min.js` và vài file `.wasm`. Tải lại extension trong
`chrome://extensions` (nút ↻) là dùng được engine Whisper.

> Model Whisper (~145MB) KHÔNG tải ở đây — nó tự tải từ HuggingFace lần đầu bạn
> bấm chấm điểm, và được trình duyệt cache cho các lần sau.

## (Tuỳ chọn) Silero VAD — tự dừng ghi âm bằng AI

`download-vendor` cũng tải thêm (bỏ qua được nếu lỗi):

- `ort.min.js` (onnxruntime-web standalone) + vài `ort-*.wasm`
- `silero_vad_v5.onnx` (~2MB) — model VAD

Sau khi có đủ file, bật trong Side Panel: **Cài đặt luyện tập → Silero VAD**. Nếu thiếu
file hoặc lỗi, extension tự dùng VAD theo RMS (không cần làm gì). Module: `vad-silero.js`.

Nếu chưa chạy bước này, extension vẫn hoạt động với engine **Web Speech API**
(chọn trong overlay) — không cần cài gì thêm.
