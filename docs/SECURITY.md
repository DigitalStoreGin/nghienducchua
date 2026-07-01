# NghienDeutsch — Bảo mật & Hardening

Tài liệu tóm tắt mô hình bảo mật, những gì đã làm cứng, và giới hạn thực tế (đặc biệt về "chống copy" MV3).

## 1. Mô hình & nguyên tắc
- **Server-authoritative**: mọi quyền lợi (gói, hết hạn, quota, model) do **Worker + Supabase** quyết định, KHÔNG tin client. Extension chỉ hiển thị.
- **Không secret ở client**: extension KHÔNG chứa API key nào. Toàn bộ key (Groq/Gemini/DeepL/Brevo/…) nằm ở Cloudflare Worker secrets. Key nhà cung cấp lưu DB được mã hoá AES-256-GCM (`KEY_ENCRYPTION_KEY`).
- **Least privilege**: RLS bật mọi bảng; client chỉ đọc/ghi hàng của mình; bảng admin/API/payment chỉ `service_role` (Worker).

## 2. Đã làm cứng (đợt này)
| Hạng mục | Chi tiết |
|---|---|
| Thu hồi phiên | `/admin/users/signout` set `profiles.sessions_revoked_at` + Supabase admin logout; `verifyToken` chặn token có `iat` < mốc thu hồi → **đăng xuất tức thì**. |
| Hết hạn license | `plan_expires_at` enforce ở `/me` + `free_hour_check/status` + cron `downgrade_expired_plans`. Pro hết hạn → tự về free phía server. |
| Ban | `profiles.banned` chặn mọi route (cache 10s qua `userFlags`). |
| Webhook SePay | Apikey + dedupe `provider_txn_id` + kiểm tiền/tiền tệ + **HMAC-SHA256 tuỳ chọn** (`SEPAY_HMAC_SECRET`). |
| Message origin | `chrome.runtime.onMessage` bỏ qua `sender.id` lạ (chỉ nhận từ chính extension). |
| Header admin | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` cho trang Admin SPA. |
| Rate limit | Cloudflare native 30 req/60s per user cho /translate; theo IP cho /log,/score,/upgrade. |
| verifyToken cache | 30s in-memory (giảm gọi /auth/v1/user), giới hạn 500 token/isolate. |
| Anomaly | Đổi quốc gia giữa 2 login + **impossible-travel** (khoảng cách/thời gian) trong Admin. |

## 3. "Chống copy Extension" — sự thật kỹ thuật
MV3 là JavaScript **đọc được**; không có cách chặn triệt để việc giải nén/copy mã. Obfuscation chỉ làm chậm, không phải bảo vệ. **Bảo vệ thật** = những gì đã làm ở trên:
- Tính năng giá trị (STT/score/dịch trả phí) chạy **qua Worker có xác thực** — copy client KHÔNG lấy được quyền lợi nếu không có tài khoản hợp lệ + gói còn hạn.
- Không có secret trong client để trộm.
- Thu hồi phiên + ban + hết hạn = kiểm soát truy cập phía server.

Khuyến nghị thêm (tuỳ chọn, roadmap):
- Ký "entitlement token" ngắn hạn (HMAC) cho từng phiên tính năng.
- Giới hạn thiết bị (config `app_settings.limits.device_limit_per_day`) — hiện đếm được, bật `device_limit_enabled` để cưỡng chế.
- CSP chặt cho Admin SPA (hiện để Report-Only/khuyến nghị vì chưa test được tự động).

## 4. Điểm cần theo dõi
- `free_hour_check` fail-open (UX > security) — đã log `[FREE_HOUR_FAIL_OPEN]`.
- Access token Supabase sống tối đa ~1h: thu hồi phiên có hiệu lực tức thì nhờ kiểm `iat`, nhưng nếu bỏ kiểm `iat` thì chỉ hết hiệu lực sau khi token hết hạn.
- Email freemail (gmail) qua Brevo dễ vào spam — nên dùng domain riêng + DKIM/DMARC.

## 5. Việc người dùng phải làm
- **Rotate mọi key đã lộ trong chat** (Cloudflare, Supabase, Brevo, GitHub, Groq) — bắt buộc.
- Đặt `SEPAY_HMAC_SECRET` nếu SePay hỗ trợ chữ ký.
- Cân nhắc verify domain gửi email (DKIM/DMARC) thay cho gmail.
