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

commit;
