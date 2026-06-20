# Shadow STT Server (tuỳ chọn — engine "Server")

Cho nhận diện giọng chính xác mà **không cần nhúng Whisper vào extension**.

## Chạy local
```bash
cd server
pip install -r requirements.txt
# chọn cỡ model: tiny (nhanh) / base (cân bằng) / small / medium (chính xác)
export WHISPER_MODEL=base
uvicorn app:app --host 0.0.0.0 --port 8000
```
Mở http://localhost:8000/health thấy `{"ok":true}` là được.
Trong extension: Engine = **Server**, URL = `http://localhost:8000`.

> Lần đầu sẽ tải model faster-whisper (~vài chục–trăm MB) rồi cache.
> Trang YouTube là https nhưng `http://localhost` được Chrome cho phép (không bị mixed-content).

## Deploy cloud (để gửi khách)
Đưa server này lên Render/Railway/Fly/VPS, mở HTTPS, rồi dùng URL https đó trong extension.
Lưu ý chi phí host + RAM cho model. Có GPU thì đặt `WHISPER_DEVICE=cuda WHISPER_COMPUTE=float16`.

## "Server trước → local sau"
- Mặc định dùng Server (dễ, chính xác).
- Khi muốn 0$ offline: chạy `build-release` để nhúng Whisper local rồi đổi Engine = Whisper.
