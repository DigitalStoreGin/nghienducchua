# NghienDeutsch — Đánh giá Fullstack & Trạng thái khắc phục

> Vai trò: kỹ sư fullstack rà soát toàn hệ thống (Extension ↔ Cloudflare Worker ↔ Supabase ↔ Admin SPA).
> Tài liệu này tổng hợp: **đã sửa gì**, **nên cải thiện gì**, **nên cắt giảm gì**, và trạng thái 8 lỗi đã nêu.

---

## 1. Thay đổi trong đợt này (đã làm)

| # | Hạng mục | Nội dung |
|---|----------|----------|
| 1 | 💶 Tiền tệ | Giá Pro chuẩn hoá **3.99 €** (bỏ kiểu cent 999). VND **tự động quy đổi LIVE** theo tỷ giá ECB (Frankfurter → open.er-api → dự phòng), cache 6h. IBAN luôn hiện **EUR**, QR VN luôn hiện **VND**. |
| 2 | 🧾 Mã đơn | Verwendungszweck = **`DE-#####`** (5 số ngẫu nhiên), khớp regex webhook SePay → tự cập nhật đơn trong Doanh thu admin. |
| 3 | ✉️ Email | Template Pro (tiếng Đức, có thương hiệu) **tự điền `{{name}}` + `{{plan}}`**, tự gửi qua Brevo khi khách đặt đơn. |
| 4 | 🎮 Game | Bỏ chế độ **"Nói & chấm"** trong Ôn tập từ vựng. |
| 5 | 🏷️ Gói | Free = **"1 giờ/ngày"**, Pro = **"Không giới hạn"** (chip đăng nhập, thẻ giá, đồng hồ usage). |
| 6 | 🎨 UI | Làm lại luồng nâng cấp Pro: thẻ giá €, nút phương thức có chip tiền tệ (EUR/VND), thẻ giá theo phương thức, i18n đầy đủ. |
| 7 | ☁️ Đồng bộ | **Từ vựng/câu đã lưu đồng bộ theo TÀI KHOẢN** qua bảng `user_data` + endpoint `/sync` → đăng nhập máy nào cũng có dữ liệu. |
| 8 | 🛠️ Admin | Giải thích nút **tải ảnh QR** (VN_QR cần ảnh, IBAN chỉ text); giá VND hiển thị "tự động". |

---

## 2. "New account thiếu chức năng" — nguyên nhân thực & cách sửa

**Triệu chứng**: tài khoản mới trên máy/trình duyệt mới không thấy từ vựng đã lưu, cảm giác "mất chức năng".

**Nguyên nhân (không phải bug phân quyền)**:
- Từ vựng/câu/yêu thích trước đây lưu ở `chrome.storage.local` (key `sd_data_v1`) — **theo trình duyệt**, không gắn tài khoản, không lên server. Máy mới ⇒ rỗng.
- Auto-pin (`chrome.sidePanel.setPanelBehavior`) và nút Lưu **không** bị giới hạn theo gói/tài khoản — chúng chạy cho mọi user. Khác biệt thực tế giữa tài khoản chỉ là **gói** (free bị chặn sau 1 giờ).

**Đã sửa**: thêm đồng bộ server (`/sync` + bảng `user_data`). Khi đăng nhập, extension **kéo về + hợp nhất (union)** vào local rồi đẩy superset; mỗi thay đổi đẩy lại (debounce 2.5s). Dữ liệu nay **đi theo tài khoản** trên mọi thiết bị.

---

## 3. Trạng thái 8 lỗi đã nêu

| # | Mức | Vấn đề | Trạng thái |
|---|-----|--------|-----------|
| 1 | 🔴 Critical | API keys lộ trong chat | ⚠️ **NGƯỜI DÙNG phải tự rotate** (xem mục 5). Không thể làm thay. |
| 2 | 🟡 Medium | `verifyToken()` không cache | ✅ Đã thêm cache in-memory 30s (giảm gọi `/auth/v1/user`, có giới hạn 500 token/isolate). |
| 3 | 🟡 Medium | `free_hour_check` fail-open im lặng | ✅ Vẫn fail-open (UX) nhưng **log `[FREE_HOUR_FAIL_OPEN]`** khi RPC null để giám sát. |
| 4 | 🟡 Medium | `usage_rollup_daily` không được điền | ✅ Thêm RPC `rollup_usage_daily()` + gọi trong cron hằng ngày. |
| 5 | 🟡 Medium | SePay webhook chỉ verify Apikey | ✅ Thêm **HMAC-SHA256 tuỳ chọn** (`SEPAY_HMAC_SECRET`, header `X-Sepay-Signature`) + giữ Apikey + dedupe `provider_txn_id` + kiểm số tiền/tiền tệ. |
| 6 | 🔵 Low | Admin TOTP UI chưa đủ | ✅ **Thực ra đã đầy đủ**: trang Bảo mật có enroll/verify/disable (`/admin/2fa/*`). Không cần sửa. |
| 7 | 🔵 Low | `subscriptions` ít dùng | ✅ Thêm `profiles.plan_expires_at`; `admin_set_plan` set thẳng vào profiles (subscriptions giữ để tương thích). |
| 8 | 🔵 Low | Brevo 400 không log rõ | ✅ Log `[BREVO-ERR]`/`[RESEND-ERR]` kèm status+body + lưu `email_last_error` vào KV → **hiện trong Admin → Health** (`health.email`). |

---

## 4. Khuyến nghị — Nên cải thiện

1. **Cache bản dịch (Cloudflare KV)**: câu giống nhau dịch lại tốn quota Gemini. Cache theo hash câu → giảm mạnh chi phí, tăng tốc.
2. **Cache transcript STT**: tương tự, theo hash audio (nếu khả thi) — giảm gọi Groq.
3. **Health surfaces lỗi email**: hiện `[BREVO-ERR]` chỉ vào log. Nên thêm đếm lỗi email vào `/admin/health` để admin thấy ngay khi sender chưa verify.
4. **Đồng bộ có tombstone**: `/sync` hiện union (không mất dữ liệu) nhưng xoá từ ở máy A có thể "sống lại" từ máy B. Nếu cần xoá chuẩn, thêm cột `updated_at`/tombstone theo item.
5. **Tỷ giá**: cân nhắc lưu tỷ giá cuối cùng vào `payout_config` để có fallback bền hơn khi cả 2 API tỷ giá lỗi (hiện dùng hằng số 27.300).
6. **i18n Worker**: thông báo lỗi từ Worker vẫn tiếng Việt/Anh cố định. Có thể trả mã lỗi + để client dịch (extension đã có vi/en/de).

## 5. Khuyến nghị — Nên cắt giảm / đơn giản hoá

1. **Bảng `subscriptions`**: trùng vai trò với `profiles.plan`. Cân nhắc dừng ghi, chỉ giữ `profiles.plan` + `plan_expires_at`.
2. **Tier `basic`/`lifetime`** còn sót trong seed cũ (`plans`/`price_table`): hệ thống nay chỉ dùng **free/pro** — nên xoá để bớt nhầm lẫn.
3. **Field `proVnd` ở admin**: nay là read-only (VND auto). Có thể ẩn hẳn ở đợt sau.
4. **Hai bộ sinh mã** (`genRef` công khai vs `refCode` admin): đã thống nhất public dùng `DE-#####`; admin vẫn `refCode` cho đơn thủ công — chấp nhận được, nhưng có thể gộp.

---

## 6. 📧 Vì sao KHÔNG nhận được email (Resend + Brevo)?

**Nguyên nhân chính**: Worker thiếu secret. `wrangler.toml` trước đây **không khai báo `BREVO_API_KEY`** ⇒ `sendBrevo` trả `[BREVO-MISSING]` ⇒ khách không nhận email; `RESEND_API_KEY` để trống ⇒ chủ cũng không nhận. (Sender Brevo `thoatran21012@gmail.com` của bạn **đã Verified** nên chỉ cần set key là chạy.)

**Đã sửa trong code**: email chủ ưu tiên Resend, **lỗi/thiếu → tự fallback Brevo**; log chi tiết status+body; hiện lỗi gần nhất ở **Admin → Health**.

**Bạn cần set secret rồi deploy**:
```
cd worker
npx wrangler secret put BREVO_API_KEY     # dán Brevo API key MỚI (đã rotate)
npx wrangler secret put BREVO_SENDER       # thoatran21012@gmail.com
npx wrangler secret put ALERT_EMAIL        # email bạn muốn nhận đơn Pro
# (tuỳ chọn) npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

## 7. ⚠️ Việc NGƯỜI DÙNG phải tự làm (không thể làm thay)

1. **Rotate toàn bộ API key đã lộ trong chat** (CRITICAL — lần này gồm Cloudflare, Supabase, Brevo bạn vừa gửi): tạo key mới trên dashboard, đặt lại secret cho Worker. **Không dán key vào chat nữa.**
2. **Chạy migration** trên Supabase SQL Editor (theo thứ tự): `008_pricing_sync_rollup.sql` rồi `009_freehour_status_planexp.sql` — tạo `user_data`, `rollup_usage_daily`, `free_hour_status`, `profiles.plan_expires_at`, giá 3.99€.
3. **Set secret email** (mục 6) — đây là lý do chưa có email.
4. **Deploy Worker** (`wrangler deploy`) + **reload extension** (chrome://extensions → Update). `/sync` chỉ hoạt động sau khi deploy + chạy migration 008.
5. **Verify sender Brevo** đã xong (Verified) — chỉ cần set key.
