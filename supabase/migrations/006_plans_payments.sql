-- ============================================================================
-- 006_plans_payments.sql — Rút gói còn free + pro; thêm cột QR ảnh; giá chỉnh trong Admin.
-- Idempotent: chạy lại an toàn. Chạy SAU 001..004.
-- ============================================================================

-- ───────── 1. Chỉ giữ 2 gói: free + pro ─────────
delete from public.plans where name in ('basic', 'lifetime');

-- Đảm bảo free + pro tồn tại với hạn mức hợp lý (cập nhật nếu đã có).
insert into public.plans (name, display_name, daily_translations, daily_ai_calls, price_usd, features) values
  ('free', 'Free', 20,   10,   0,    '["20 dịch/ngày","10 lượt AI/ngày","Shadowing cơ bản"]'::jsonb),
  ('pro',  'Pro',  2000, 1000, 9.99, '["2000 dịch/ngày","1000 lượt AI/ngày","Ghi âm & chấm điểm AI","Ưu tiên hỗ trợ"]'::jsonb)
on conflict (name) do update set
  display_name = excluded.display_name,
  daily_translations = excluded.daily_translations,
  daily_ai_calls = excluded.daily_ai_calls,
  features = excluded.features;

-- Hạ mọi user gói cũ (basic/lifetime) về pro (đang trả phí) để không mất quyền lợi.
update public.profiles set plan = 'pro' where plan in ('basic', 'lifetime');

-- ───────── 2. admin_set_plan: bỏ nhánh 'lifetime' (chỉ months-based) ─────────
create or replace function public.admin_set_plan(
  p_user_id uuid,
  p_plan    text,
  p_months  int default 12
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set plan = p_plan, updated_at = now() where id = p_user_id;

  insert into public.subscriptions (user_id, plan, status, current_period_start, current_period_end)
  values (p_user_id, p_plan, 'active', now(), now() + (p_months || ' months')::interval)
  on conflict do nothing;

  update public.subscriptions
  set plan = p_plan, status = 'active',
      current_period_start = now(),
      current_period_end = now() + (p_months || ' months')::interval,
      updated_at = now()
  where user_id = p_user_id
    and id = (select id from public.subscriptions where user_id = p_user_id order by created_at desc limit 1);
end;
$$;

-- ───────── 3. payout_config: thêm cột ảnh QR (base64 data-URI) + giá 2 gói ─────────
alter table if exists public.payout_config add column if not exists qr_image text;

-- Cập nhật bảng giá còn free + pro (giữ giá pro hiện có nếu đã chỉnh).
update public.payout_config
set price_table = jsonb_build_object(
      'free', jsonb_build_object('EUR', 0, 'VND', 0),
      'pro',  coalesce(price_table->'pro', '{"EUR":999,"VND":249000}'::jsonb)
    )
where id = 1;
