# NghienDe — Admin Panel

SPA tĩnh (HTML/CSS/JS thuần, không build) chạy trên **Cloudflare Pages**, dùng lại
**Cloudflare Worker** + **Supabase** sẵn có. Song ngữ 🇻🇳/🇩🇪, sáng/tối, đăng nhập bảo mật
(PBKDF2 + JWT + 2FA tuỳ chọn). Chủ sở hữu đăng nhập được trên điện thoại/desktop.

## 4 trang
1. **Tổng quan** — số người dùng, người mới 30 ngày, phân bố gói, hạn mức API (đã dùng/tổng), doanh thu, nhật ký quản trị.
2. **Hệ thống** — tình trạng (Worker/Supabase/keys), quản lý **API key pool** (thêm key + hạn mức, bật/tắt, xoá), nhà cung cấp (gồm session 9router — mặc định TẮT, có cảnh báo rủi ro).
3. **Người dùng** — tìm, đổi gói (free/basic/pro/lifetime), đổi nguồn chấm (server/local/dedicated), cấm/bỏ cấm, xoá tài khoản.
4. **Thanh toán** — sửa thông tin nhận tiền (IBAN/PayPal/SePay) **không cần đổi code**, tạo đơn (tự sinh mã `DE-xxxxxxx`/`VN-xxxxxxx`), đánh dấu đã trả → tự nâng gói. SePay webhook tự cập nhật.

## Triển khai

### 1) Supabase
SQL Editor → chạy `supabase/migrations/002_admin.sql` (idempotent, chạy lại an toàn).
Seed sẵn nhà cung cấp + 1 dòng `payout_config` (tên + IBAN của bạn — sửa được trong trang Thanh toán).

### 2) Worker (thư mục `worker/`)
```bash
npx wrangler secret put ADMIN_JWT_SECRET     # khoá ký JWT phiên admin (chuỗi ngẫu nhiên dài)
npx wrangler secret put KEY_ENCRYPTION_KEY   # khoá mã hoá API key trong DB (chuỗi ngẫu nhiên dài)
npx wrangler secret put SEPAY_WEBHOOK_KEY    # (khi bật SePay) khoá xác thực webhook
# ADMIN_KEY đã có — chỉ dùng cho bước bootstrap lần đầu
npx wrangler deploy                          # đã có [triggers] crons để reset hạn mức + dọn session
```

### 3) Cloudflare Pages
- Tạo project Pages từ repo (hoặc upload thư mục `admin/`).
- **Framework preset: None**, Build command: trống, **Build output: `admin`** (hoặc gốc nếu deploy riêng thư mục admin).
- `_headers` đã set CSP/HSTS; `_redirects` cho SPA. Nếu Worker URL khác, sửa `admin/assets/config.js` **và** `connect-src` trong `_headers`.

### 4) Khởi tạo chủ sở hữu (1 lần)
1. Mở trang admin → bấm **"Khởi tạo lần đầu"**.
2. Nhập email + mật khẩu mạnh (≥10 ký tự) + `ADMIN_KEY`. Bấm **Tạo tài khoản chủ**.
3. Đăng nhập. Vào (sau này) bật **2FA (TOTP)** để bảo mật tối đa. Sau khi có 1 owner, endpoint bootstrap tự khoá.

## Bảo mật
- Mật khẩu băm **PBKDF2-HMAC-SHA256 (150k vòng)** — chỉ ở Worker, so sánh hằng-thời-gian.
- Phiên = JWT HMAC ngắn hạn (60') + bảng `admin_sessions` có cờ **revoked** để thu hồi ngay.
- Khoá đăng nhập luỹ tiến khi sai ≥5 lần; rate-limit theo IP. 2FA TOTP tuỳ chọn.
- API key nhà cung cấp lưu DB **mã hoá AES-GCM** (KEY_ENCRYPTION_KEY); không bao giờ trả secret về client.
- Mọi hành động ghi `audit_log`. CSP chặn khung nhúng/script lạ.

## Còn lại (tích hợp khi có thông tin)
- **Wiring pool key vào endpoint live** (`/transcribe`, `/score-ai`, `/ai-translate`) để `credit_*_used` tự trừ theo traffic thật — hiện admin quản lý + thống kê hạn mức nhập tay; helper rotation đã sẵn trong Worker.
- **SePay API** (bạn cấp sau) → điền account/bank + bật webhook `POST /sepay/webhook`.
- **PayPal donate link** (bạn cấp sau) → dán vào trang Thanh toán.
