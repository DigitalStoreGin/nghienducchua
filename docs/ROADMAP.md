# NghienDeutsch — Roadmap & Trạng thái nền tảng SaaS

Cập nhật theo đợt nâng cấp lớn (Thanh toán/Email + Analytics/Dashboard + Geo/Sessions + License/Bảo mật).

## ✅ Đã làm
| Phase | Nội dung |
|---|---|
| A | Sửa form thanh toán: mã CK xếp dọc (hết số lạc), nhãn theo phương thức (IBAN→Verwendungszweck, QR→Nội dung chuyển khoản), placeholder "Email", admin Email hiển thị mẫu mặc định thương hiệu. |
| B | Analytics backend: RPC `usage_timeseries` / `usage_by_user` / `capacity_estimate`; endpoint `/admin/analytics/*`. |
| C | Dashboard + System: biểu đồ SVG (calls/ngày), KPI công suất (DAU/WAU/MAU, calls/tokens 24h, ước lượng), bảng top-user. |
| D | Geo/thiết bị browserscan: enrich `login_events` (region/asn/colo/tls/proto/toạ độ); panel user (cờ, ISP, ASN, TLS, protocol) + impossible-travel; **thu hồi phiên** (server-side, tức thì). |
| E | License: enforce `plan_expires_at` (me + gate + cron hạ gói); `/me` trả entitlements + feature_flags; seed config `feature_flags` + `limits`. |
| F | Hardening: header bảo mật admin, message-origin guard, HMAC SePay tuỳ chọn, verifyToken cache; `docs/SECURITY.md`. |

## 🔜 Roadmap (chưa làm — cần đợt riêng)
| Ưu tiên | Hạng mục | Ghi chú |
|---|---|---|
| Cao | **Cưỡng chế giới hạn thiết bị** | Config `app_settings.limits` đã có; cần bật đếm + deny khi vượt (chống share). |
| Cao | **Entitlement token ký HMAC** | Ký token ngắn hạn cho mỗi phiên tính năng → khó lạm dụng hơn. |
| TB | **RBAC nhiều vai trò** | Hiện chỉ `owner`. Thêm `moderator` (chỉ đọc / không xoá). |
| TB | **Feature flags UI trong admin** | `/me` đã trả; cần trang admin bật/tắt + extension khoá tính năng. |
| TB | **Update system** | Kiểm tra phiên bản extension, thông báo cập nhật, rollout theo nhóm. |
| TB | **Error/System log tập trung** | Hiện log ra console Worker + KV email error; nên gom vào bảng + trang admin. |
| Thấp | **CSP chặt cho Admin** | Thêm sau khi test không vỡ giao diện. |
| Thấp | **Dọn schema** | Gộp/loại `subscriptions` (đã có `profiles.plan_expires_at`); xoá tier basic/lifetime cũ. |
| Thấp | **Cache dịch/STT (KV)** | Giảm chi phí Gemini/Groq cho câu/audio trùng. |

## 🧪 QA checklist (test tay sau khi deploy + migration)
Chạy migration 008 → 009 → 010, `wrangler deploy`, reload extension.

**Extension:**
- [ ] Nghe (listen): bấm ▷ Nghe phát đúng đoạn.
- [ ] Nói & chấm (score): ghi âm → có điểm ngữ âm; free hết 1 giờ → bị chặn.
- [ ] Dịch (translate): free dùng dịch trình duyệt; pro dùng Gemini/DeepL.
- [ ] Đổi ngôn ngữ giao diện vi/en/de → mọi chữ đổi (không sót).
- [ ] Nâng cấp Pro: mã DE-##### KHÔNG xuống dòng; IBAN hiện "Verwendungszweck", QR hiện "Nội dung chuyển khoản"; done-step cùng mã.
- [ ] Từ vựng: lưu từ → đăng nhập máy khác thấy (sau khi /sync chạy).
- [ ] Tự mở panel khi vào video (tắt được trong Cài đặt).

**Email:**
- [ ] Đặt đơn → chủ nhận email; khách nhận email (kiểm cả Spam). Nếu vào spam → dùng domain riêng verify DKIM/DMARC.

**Admin:**
- [ ] Dashboard: biểu đồ calls/ngày + KPI công suất + top-user hiển thị.
- [ ] System: mục "Phân tích sử dụng".
- [ ] User detail: geo (cờ/ISP/ASN/TLS), impossible-travel, nút "Thu hồi phiên" → user phải đăng nhập lại.
- [ ] Hết hạn Pro → tự về free (cron/đăng nhập lại).
