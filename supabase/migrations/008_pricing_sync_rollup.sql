-- 008_pricing_sync_rollup.sql
-- 1) Giá Pro = 3.99€ (EUR là nguồn chuẩn; VND quy đổi LIVE trong Worker qua tỷ giá ECB/open.er-api).
-- 2) RPC rollup_usage_daily() để cron điền bảng usage_rollup_daily (vấn đề #4).
-- 3) Bảng user_data: đồng bộ từ vựng/câu đã lưu theo TÀI KHOẢN (đăng nhập máy nào cũng có dữ liệu).

begin;

-- ─────────────────────────────────────────────────────────────
-- 1) Chuẩn hoá giá: EUR theo đơn vị euro (3.99), KHÔNG còn dạng cent (999).
--    Free = 0€. VND không lưu nữa (Worker quy đổi trực tiếp khi hiển thị).
-- ─────────────────────────────────────────────────────────────
update public.payout_config
set price_table = jsonb_build_object(
      'free', jsonb_build_object('EUR', 0),
      'pro',  jsonb_build_object('EUR', 3.99)
    )
where id = 1;

-- Bảng plans: cập nhật giá tham khảo (price_usd đã deprecated, giữ cho tương thích).
update public.plans set price_usd = 3.99 where name = 'pro';

-- ─────────────────────────────────────────────────────────────
-- 2) Gộp usage_rollup_daily từ api_usage_events (gọi trong cron hằng ngày).
--    Bỏ qua dòng thiếu user_id/provider_id (PK không cho NULL).
-- ─────────────────────────────────────────────────────────────
create or replace function public.rollup_usage_daily(p_date date default (current_date - 1))
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.usage_rollup_daily where date = p_date;
  insert into public.usage_rollup_daily
    (date, user_id, provider_id, server_stt_seconds, local_stt_seconds, calls, tokens, est_cost)
  select
    p_date, e.user_id, e.provider_id,
    coalesce(sum(case when e.run_location = 'server' and e.endpoint = 'transcribe' then e.units else 0 end), 0),
    coalesce(sum(case when e.run_location = 'local'  and e.endpoint = 'transcribe' then e.units else 0 end), 0),
    count(*)::bigint,
    coalesce(sum(coalesce(e.tokens_in, 0) + coalesce(e.tokens_out, 0)), 0)::bigint,
    coalesce(sum(e.est_cost), 0)::numeric
  from public.api_usage_events e
  where e.ts >= p_date::timestamptz
    and e.ts <  (p_date + 1)::timestamptz
    and e.user_id is not null
    and e.provider_id is not null
  group by e.user_id, e.provider_id;
end;
$$;
grant execute on function public.rollup_usage_daily(date) to service_role;

-- ─────────────────────────────────────────────────────────────
-- 3) Đồng bộ dữ liệu người dùng theo tài khoản (từ vựng / câu đã lưu / yêu thích).
--    Worker đọc/ghi bằng service_role (bypass RLS); policy dưới cho phép client
--    đăng nhập tự đọc/ghi đúng hàng của mình nếu sau này gọi Supabase trực tiếp.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.user_data (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  saved_words     jsonb       not null default '[]'::jsonb,
  saved_sentences jsonb       not null default '[]'::jsonb,
  favorites       jsonb       not null default '[]'::jsonb,
  updated_at      timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists user_data_self on public.user_data;
create policy user_data_self on public.user_data
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

commit;
