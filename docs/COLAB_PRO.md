# Colab Pro — có giúp được gì cho NghienDe không?

**Tóm tắt: Có ích cho NGHIÊN CỨU/THỬ NGHIỆM và làm backend GPU TẠM THỜI, KHÔNG dùng cho
production phục vụ khách** (phiên Colab tự ngắt sau vài giờ, không phải hạ tầng phục vụ ổn định).

## Có thể tận dụng ở đâu trong codebase
1. **Server chấm âm vị GPU** — dự án đã có `server/app.py` (`/score`, wav2vec2 + GOP, espeak).
   Colab Pro (T4/L4) chạy server này nhanh hơn nhiều CPU; phơi tạm qua `cloudflared`/`ngrok` rồi
   trỏ `settings.serverUrl` của extension vào URL đó để **thử** chấm điểm chất lượng cao khi dev.
2. **Batch sinh dữ liệu từ vựng** — chạy LLM/Whisper local trên Colab để tạo sẵn IPA/định nghĩa/ví dụ
   cho danh sách từ phổ biến (de/en), rồi import vào từ điển tĩnh → giảm phụ thuộc API runtime.
3. **So đường ngữ điệu (F0)** — thử CREPE/pYIN trên Colab để tinh chỉnh thuật toán chấm "Intonation"
   trước khi đưa vào `content/phonetic.js` (mục nâng cấp đã ghi trong README).

## Vì sao KHÔNG dùng cho production
- Phiên Colab giới hạn thời gian, có thể bị thu hồi GPU; URL tunnel đổi liên tục → không cam kết uptime.
- Không phù hợp để hàng trăm khách gọi đồng thời.

## Khuyến nghị
- Production: giữ Groq (server) + Whisper **local trên máy khách** (miễn phí) như hiện tại; mở rộng bằng
  **pool nhiều API key** trong trang admin.
- Nếu cần GPU bền vững sau này: RunPod / Fly.io GPU / HuggingFace Inference Endpoints.
- (Tuỳ chọn) Có thể thêm `model_source = 'colab-tunnel'` tạm trong admin để bật/tắt backend Colab khi thử.
