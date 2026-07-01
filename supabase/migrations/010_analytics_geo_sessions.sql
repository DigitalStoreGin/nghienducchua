-- 010_analytics_geo_sessions.sql
-- Gộp DB cho đợt lớn:
--   B) Analytics: usage_timeseries / usage_by_user / capacity_estimate
--   D) Geo/thiết bị: thêm cột login_events + profiles.sessions_revoked_at (thu hồi phiên)
--   E) License/flags: app_settings feature_flags + device_limit (plan_expires_at đã ở 009)
-- Idempotent. Chạy SAU 001..009.

begin;

-- ─────────────────────────────────────────────────────────────
-- B) ANALYTICS RPCs (đọc api_usage_events / login_events)
-- ─────────────────────────────────────────────────────────────

-- Chuỗi thời gian theo NGÀY (N ngày gần nhất): calls, tokens, errors, cost, users.
create or replace function public.usage_timeseries(p_days int default 14)
returns table(day date, calls bigint, tokens bigint, errors bigint, est_cost numeric, users bigint)
language sql security definer set search_path = public as $$
  select (e.ts at time zone 'UTC')::date as day,
         count(*)::bigint,
         coalesce(sum(coalesce(e.tokens_in,0) + coalesce(e.tokens_out,0)), 0)::bigint,
         count(*) filter (where not e.success)::bigint,
         coalesce(sum(e.est_cost), 0)::numeric,
         count(distinct e.user_id)::bigint
  from public.api_usage_events e
  where e.ts >= (current_date - (greatest(1, least(p_days, 90)) - 1))::timestamptz
  group by 1
  order by 1;
$$;
grant execute on function public.usage_timeseries(int) to service_role;

-- Top người dùng theo mức sử dụng (calls / tokens / cost) trong N ngày.
create or replace function public.usage_by_user(p_days int default 30, p_limit int default 10)
returns table(user_id uuid, email text, plan text, calls bigint, tokens bigint, est_cost numeric)
language sql security definer set search_path = public as $$
  select e.user_id, p.email, p.plan,
         count(*)::bigint,
         coalesce(sum(coalesce(e.tokens_in,0) + coalesce(e.tokens_out,0)), 0)::bigint,
         coalesce(sum(e.est_cost), 0)::numeric
  from public.api_usage_events e
  left join public.profiles p on p.id = e.user_id
  where e.ts >= (current_date - (greatest(1, least(p_days, 90)) - 1))::timestamptz
    and e.user_id is not null
  group by e.user_id, p.email, p.plan
  order by 4 desc
  limit greatest(1, least(p_limit, 100));
$$;
grant execute on function public.usage_by_user(int, int) to service_role;

-- Ước lượng công suất: DAU/WAU/MAU + calls/tokens 24h + giới hạn tham chiếu.
create or replace function public.capacity_estimate()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_dau int; v_wau int; v_mau int; v_calls24 bigint; v_tok24 bigint; v_stt24 bigint; v_paid int; v_total int;
begin
  select count(distinct user_id) into v_dau from public.login_events where ts >= now() - interval '1 day';
  select count(distinct user_id) into v_wau from public.login_events where ts >= now() - interval '7 day';
  select count(distinct user_id) into v_mau from public.login_events where ts >= now() - interval '30 day';
  select count(*), coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)), 0)
    into v_calls24, v_tok24 from public.api_usage_events where ts >= now() - interval '1 day';
  select count(*) into v_stt24 from public.api_usage_events
    where ts >= now() - interval '1 day' and endpoint = 'transcribe';
  select count(*) into v_paid from public.profiles where plan = 'pro';
  select count(*) into v_total from public.profiles;
  return jsonb_build_object(
    'dau', coalesce(v_dau,0), 'wau', coalesce(v_wau,0), 'mau', coalesce(v_mau,0),
    'calls_24h', coalesce(v_calls24,0), 'tokens_24h', coalesce(v_tok24,0), 'stt_24h', coalesce(v_stt24,0),
    'paid_users', coalesce(v_paid,0), 'total_users', coalesce(v_total,0),
    -- Giới hạn tham chiếu (5 Groq keys, 1 Gemini) — theo docs/ARCHITECTURE D12.
    'limits', jsonb_build_object('stt_rpd', 10000, 'score_rpd', 72000, 'gemini_rpd', 1500),
    'est_free_dau_max', 100, 'est_pro_dau_max', 50
  );
end; $$;
grant execute on function public.capacity_estimate() to service_role;

-- ─────────────────────────────────────────────────────────────
-- D) GEO/THIẾT BỊ + THU HỒI PHIÊN
-- ─────────────────────────────────────────────────────────────
alter table if exists public.login_events add column if not exists region        text;
alter table if exists public.login_events add column if not exists asn           text;
alter table if exists public.login_events add column if not exists colo          text;
alter table if exists public.login_events add column if not exists tls_version   text;
alter table if exists public.login_events add column if not exists http_protocol text;
alter table if exists public.login_events add column if not exists latitude      text;
alter table if exists public.login_events add column if not exists longitude     text;

-- Mốc thu hồi phiên: verifyToken chặn token có iat < mốc này (thu hồi tức thì).
alter table if exists public.profiles add column if not exists sessions_revoked_at timestamptz;

-- ─────────────────────────────────────────────────────────────
-- E) FEATURE FLAGS + GIỚI HẠN THIẾT BỊ (config trong app_settings)
-- ─────────────────────────────────────────────────────────────
insert into public.app_settings (key, value, updated_at)
values ('feature_flags', '{"vocab_sync": true, "auto_open_panel": true, "ai_scoring": true}'::jsonb, now())
on conflict (key) do nothing;

insert into public.app_settings (key, value, updated_at)
values ('limits', '{"device_limit_per_day": 3, "device_limit_enabled": false}'::jsonb, now())
on conflict (key) do nothing;

-- Enforce hết hạn gói NGAY trong RPC cổng (Pro hết hạn plan_expires_at → tính như free).
create or replace function public.free_hour_check(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan text; v_exp timestamptz; v_first timestamptz; v_elapsed numeric;
begin
  select coalesce(plan, 'free'), plan_expires_at into v_plan, v_exp from public.profiles where id = p_user_id;
  if v_plan is null then v_plan := 'free'; end if;
  if v_plan = 'pro' and v_exp is not null and v_exp < now() then v_plan := 'free'; end if;
  if v_plan <> 'free' then
    return jsonb_build_object('allowed', true, 'plan', v_plan);
  end if;
  insert into public.usage (user_id, date, first_used_at)
  values (p_user_id, current_date, now())
  on conflict (user_id, date) do update
    set first_used_at = coalesce(usage.first_used_at, now()), updated_at = now();
  select first_used_at into v_first from public.usage where user_id = p_user_id and date = current_date;
  v_elapsed := extract(epoch from (now() - coalesce(v_first, now()))) / 60.0;
  return jsonb_build_object('allowed', (v_elapsed <= 60), 'plan', v_plan, 'elapsed_min', round(v_elapsed), 'limit_min', 60);
end; $$;

create or replace function public.free_hour_status(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan text; v_exp timestamptz; v_first timestamptz; v_used int; v_remaining int;
begin
  select coalesce(plan, 'free'), plan_expires_at into v_plan, v_exp from public.profiles where id = p_user_id;
  if v_plan is null then v_plan := 'free'; end if;
  if v_plan = 'pro' and v_exp is not null and v_exp < now() then v_plan := 'free'; end if;
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
end; $$;

-- Cron hạ gói Pro hết hạn về free (chạy trong scheduledAdmin hằng ngày).
create or replace function public.downgrade_expired_plans()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.profiles set plan = 'free', plan_expires_at = null, updated_at = now()
  where plan = 'pro' and plan_expires_at is not null and plan_expires_at < now();
  get diagnostics n = row_count;
  return n;
end; $$;
grant execute on function public.downgrade_expired_plans() to service_role;

commit;
