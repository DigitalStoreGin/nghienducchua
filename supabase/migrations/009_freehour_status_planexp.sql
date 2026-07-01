-- 009_freehour_status_planexp.sql
-- 1) free_hour_status(): ĐỌC trạng thái giờ free CÒN LẠI mà KHÔNG khởi động đồng hồ
--    (dùng cho /me hiển thị "còn X phút" — khác free_hour_check vốn bắt đầu đếm giờ).
-- 2) profiles.plan_expires_at: gộp hạn gói vào profiles (đơn giản hoá, vấn đề #7).
-- Idempotent. Chạy SAU 001..008.

begin;

-- ── 1) Trạng thái giờ free (read-only) ──────────────────────────────────────
create or replace function public.free_hour_status(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_plan text; v_first timestamptz; v_used int; v_remaining int;
begin
  select coalesce(plan, 'free') into v_plan from public.profiles where id = p_user_id;
  if v_plan is null then v_plan := 'free'; end if;
  if v_plan <> 'free' then
    return jsonb_build_object('plan', v_plan, 'unlimited', true);
  end if;
  select first_used_at into v_first from public.usage where user_id = p_user_id and date = current_date;
  if v_first is null then
    return jsonb_build_object('plan', 'free', 'unlimited', false, 'started', false, 'used_min', 0, 'remaining_min', 60, 'limit_min', 60);
  end if;
  v_used := floor(extract(epoch from (now() - v_first)) / 60.0)::int;
  v_remaining := greatest(0, 60 - v_used);
  return jsonb_build_object('plan', 'free', 'unlimited', false, 'started', true, 'used_min', v_used, 'remaining_min', v_remaining, 'limit_min', 60);
end;
$$;
grant execute on function public.free_hour_status(uuid) to service_role;

-- ── 2) Hạn gói gộp vào profiles (#7) ────────────────────────────────────────
alter table if exists public.profiles add column if not exists plan_expires_at timestamptz;

-- admin_set_plan: ngoài subscriptions (giữ tương thích) còn set thẳng profiles.plan_expires_at.
create or replace function public.admin_set_plan(
  p_user_id uuid,
  p_plan    text,
  p_months  int default 12
)
returns void language plpgsql security definer set search_path = public as $$
declare v_exp timestamptz;
begin
  v_exp := case when p_plan = 'free' then null else now() + (p_months || ' months')::interval end;

  update public.profiles
    set plan = p_plan, plan_expires_at = v_exp, updated_at = now()
    where id = p_user_id;

  insert into public.subscriptions (user_id, plan, status, current_period_start, current_period_end)
  values (p_user_id, p_plan, 'active', now(), v_exp)
  on conflict do nothing;

  update public.subscriptions
  set plan = p_plan, status = 'active',
      current_period_start = now(),
      current_period_end = v_exp,
      updated_at = now()
  where user_id = p_user_id
    and id = (select id from public.subscriptions where user_id = p_user_id order by created_at desc limit 1);
end;
$$;

commit;
