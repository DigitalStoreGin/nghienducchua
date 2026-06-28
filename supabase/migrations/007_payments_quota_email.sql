-- ============================================================================
-- 007_payments_quota_email.sql
--   • Free 60 phút/ngày (usage.first_used_at + RPC free_hour_check)
--   • Thanh toán đa phương thức (payout_config.payment_methods) + lưu thông tin khách (payments)
--   • Quản lý người dùng 360° (login_events + profiles.last_*)
-- Idempotent: chạy lại an toàn. Chạy SAU 001..006.
-- ============================================================================

-- ───────── 1. Free 60 phút/ngày ─────────
alter table if exists public.usage add column if not exists first_used_at timestamptz;

-- Đếm giờ từ lần dùng tính năng nặng ĐẦU TIÊN trong ngày. Free quá 60' → chặn (reset hôm sau).
create or replace function public.free_hour_check(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan text; v_first timestamptz; v_elapsed numeric;
begin
  select coalesce(plan, 'free') into v_plan from public.profiles where id = p_user_id;
  if v_plan is null then v_plan := 'free'; end if;
  if v_plan <> 'free' then
    return jsonb_build_object('allowed', true, 'plan', v_plan);
  end if;

  insert into public.usage (user_id, date, first_used_at)
  values (p_user_id, current_date, now())
  on conflict (user_id, date) do update
    set first_used_at = coalesce(usage.first_used_at, now()), updated_at = now();

  select first_used_at into v_first from public.usage where user_id = p_user_id and date = current_date;
  v_elapsed := extract(epoch from (now() - coalesce(v_first, now()))) / 60.0;

  return jsonb_build_object(
    'allowed', (v_elapsed <= 60),
    'plan', v_plan,
    'elapsed_min', round(v_elapsed),
    'limit_min', 60
  );
end; $$;

-- ───────── 2. Thanh toán đa phương thức + thông tin khách ─────────
alter table if exists public.payout_config add column if not exists payment_methods jsonb not null default '[]'::jsonb;
alter table if exists public.payments add column if not exists customer_name  text;
alter table if exists public.payments add column if not exists customer_email text;

-- Seed payment_methods ban đầu từ cấu hình IBAN + QR hiện có (chỉ khi còn rỗng).
update public.payout_config set payment_methods = jsonb_build_array(
    jsonb_build_object('id','iban','type','iban','label','Chuyển khoản IBAN (EU)',
      'enabled', (coalesce(iban,'') <> ''),
      'beneficiary', coalesce(beneficiary_name,''), 'iban', coalesce(iban,''),
      'bic', coalesce(bic,''), 'bank', coalesce(bank_name,'')),
    jsonb_build_object('id','vn_qr','type','vn_qr','label','QR ngân hàng (VN)',
      'enabled', (coalesce(qr_image,'') <> ''),
      'qr_image', coalesce(qr_image,''), 'note','Quét QR bằng app ngân hàng, nhập đúng nội dung chuyển khoản.')
  )
where id = 1 and (payment_methods is null or payment_methods = '[]'::jsonb);

-- ───────── 3. Quản lý người dùng 360°: lịch sử đăng nhập + thông tin phiên ─────────
create table if not exists public.login_events (
  id        bigint generated always as identity primary key,
  user_id   uuid,
  ts        timestamptz not null default now(),
  event     text not null default 'login',   -- login | ping | logout
  ip        text,
  prev_ip   text,
  ua        text,
  device    text,
  os        text,
  browser   text,
  screen    text,
  lang      text,
  timezone  text,
  country   text,
  city      text,
  isp       text,
  method    text,
  success   boolean default true
);
create index if not exists idx_login_events_user on public.login_events(user_id, ts desc);
alter table public.login_events enable row level security; -- chỉ service_role (Worker)

alter table if exists public.profiles add column if not exists last_login_at timestamptz;
alter table if exists public.profiles add column if not exists last_seen_at  timestamptz;
alter table if exists public.profiles add column if not exists last_ip       text;
alter table if exists public.profiles add column if not exists prev_ip       text;
alter table if exists public.profiles add column if not exists last_device   jsonb;
