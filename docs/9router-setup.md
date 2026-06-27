# 9router — cài cho việc code cá nhân (Claude Code / Cursor / Copilot)

> **Lưu ý quan trọng:** 9router (https://9router.com, repo `decolua/9router`) là **cổng API cho
> công cụ lập trình AI** — nó nén token cho git diff/file tree và định tuyến giữa nhiều nhà cung
> cấp model code. Nó **không** liên quan tới extension học tiếng Đức (dịch/ghi âm/chấm điểm). Phần
> "quản lý API kiểu 9Router" cho extension đã được tích hợp **thẳng trong trang Admin → Hệ thống**
> (catalog models + fallback + dashboard usage). Tài liệu này chỉ dành cho việc bạn dùng 9router để
> **code cá nhân** trên máy của bạn.
>
> 9router chạy **trên máy tính của bạn** (Docker hoặc Node). Mình không cài hộ được từ môi trường
> remote này, nên đây là hướng dẫn + lệnh chạy sẵn.

## Cách 1 — Docker (khuyến nghị, nhanh nhất)

```bash
# 1. Kéo và chạy 9router (cổng mặc định 20128)
docker run -d --name 9router \
  -p 20128:20128 \
  -v "$HOME/.9router:/root/.9router" \
  --restart unless-stopped \
  ghcr.io/decolua/9router:latest

# 2. Mở dashboard cấu hình
#    → http://localhost:20128
#    Thêm provider + API key (Groq, OpenRouter, Gemini…), bật fallback theo tier.
```

## Cách 2 — Chạy từ source (Node 20+)

```bash
git clone https://github.com/decolua/9router.git
cd 9router
npm install
npm start          # mặc định http://localhost:20128
```

## Trỏ Claude Code vào 9router

9router phơi ra endpoint **OpenAI-compatible** tại `http://localhost:20128/v1`.

```bash
# Claude Code: dùng base URL của 9router
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_API_KEY="dummy"   # 9router quản lý key thật, giá trị này chỉ là placeholder
claude
```

- **Cursor / Cline / Copilot-compatible:** trong phần *OpenAI API* của công cụ, đặt
  *Base URL* = `http://localhost:20128/v1`, *API key* = bất kỳ (placeholder). Chọn model trong
  danh sách 9router cung cấp.

## Thêm 5 key Groq vào 9router (tùy chọn)

Trong dashboard `http://localhost:20128` → **Providers → Groq → Add key**, dán lần lượt 5 key
`gsk_...`. 9router sẽ round-robin + tự fallback khi 1 key hết quota.

> ⚠️ Bảo mật: 5 key Groq bạn đã gửi trong chat coi như **đã lộ** — nên **tạo key mới** tại
> https://console.groq.com/keys và thay thế cả ở đây lẫn trên Cloudflare.

## Liên hệ với extension nghienducchua?

Không trực tiếp. Extension gọi Worker `nghienducchua-proxy...workers.dev`, và Worker đã có hệ
quản lý API riêng (trang Admin → Hệ thống → **Models & Định tuyến** + **Thống kê sử dụng**). Nếu
muốn Worker đi qua 9router, phải để 9router chạy trên một máy chủ public (VPS) rồi cấu hình Worker
gọi tới — không khuyến nghị vì thêm một điểm lỗi và độ trễ. Quản lý ngay trong Admin là đủ.
