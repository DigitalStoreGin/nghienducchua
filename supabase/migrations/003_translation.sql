-- ============================================================================
-- 003_translation.sql — Chọn API dịch theo gói (free vs trả phí) + wiring key pool.
-- Idempotent: chạy lại an toàn. Chỉ Worker (service_role) đọc/ghi.
-- Chạy trong Supabase SQL Editor SAU 001_initial.sql + 002_admin.sql.
--
-- Mục tiêu:
--   • User FREE  → dịch tự động miễn phí (YouTube/Google/Microsoft) ở client.
--   • User TRẢ PHÍ → dịch qua API "tốt hơn" (Gemini mặc định; đổi được trong Admin),
--     lấy key từ key pool (api_keys) và TỰ TRỪ credit theo lượt gọi.
--   • Admin chỉnh provider mặc định cho CẢ HỆ THỐNG hoặc TỪNG user.
-- ============================================================================

-- ───────── 1. Cấu hình toàn hệ thống (key/value) ─────────
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security; -- không policy → chỉ service_role (Worker)

-- Mặc định: gói trả phí dùng Gemini; gói free dùng nguồn dịch miễn phí ở client.
insert into public.app_settings (key, value) values
  ('translation', '{"paid_provider":"gemini","free_source":"free"}'::jsonb)
on conflict (key) do nothing;

-- ───────── 2. Ghi đè theo từng user ─────────
-- translation_provider: null = theo mặc định hệ thống; nếu set → ép provider riêng cho user này.
-- premium_translate: true = ép dùng API dịch kể cả khi gói = free (tặng/ưu đãi); mặc định theo gói.
alter table if exists public.profiles add column if not exists translation_provider text;
alter table if exists public.profiles add column if not exists premium_translate    boolean default false;

-- ───────── 3. Bổ sung nhà cung cấp Mistral vào danh mục ─────────
insert into public.api_providers (id, display_name, kind, base_url, docs_url) values
  ('mistral', 'Mistral AI', 'api_key', 'https://api.mistral.ai', 'https://console.mistral.ai/api-keys')
on conflict (id) do nothing;

-- ───────── 4. RPC: lấy 1 key tốt nhất từ pool + TỰ TRỪ credit (atomic) ─────────
-- Worker gọi với service-role. Chọn key active, ưu tiên priority nhỏ, còn hạn mức;
-- tăng credit_*_used, đánh dấu 'exhausted' khi dùng hết. Trả về { id, secret_ref }.
create or replace function public.consume_api_key(
  p_provider_id text,
  p_requests    int    default 1,
  p_tokens      bigint default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id         uuid;
  v_secret     text;
  v_req_total  bigint;
  v_req_used   bigint;
begin
  select id, secret_ref, credit_requests_total, credit_requests_used
    into v_id, v_secret, v_req_total, v_req_used
  from public.api_keys
  where provider_id = p_provider_id
    and status = 'active'
    and (credit_requests_total = 0 or credit_requests_used < credit_requests_total)
  order by priority asc, credit_requests_used asc
  limit 1
  for update skip locked;

  if v_id is null then
    return null;
  end if;

  update public.api_keys set
    credit_requests_used = credit_requests_used + p_requests,
    credit_tokens_used   = credit_tokens_used   + p_tokens,
    last_used_at         = now(),
    status = case
               when credit_requests_total > 0 and (credit_requests_used + p_requests) >= credit_requests_total
               then 'exhausted' else status end
  where id = v_id;

  return jsonb_build_object('id', v_id, 'secret_ref', v_secret);
end;
$$;

-- ───────── 5. RPC: đọc cấu hình dịch hiệu lực cho 1 user ─────────
-- Trả về { is_premium, provider, free_source } để Worker quyết định luồng dịch.
create or replace function public.translation_config_for(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan       text;
  v_premium    boolean;
  v_user_prov  text;
  v_settings   jsonb;
  v_provider   text;
  v_is_premium boolean;
begin
  select plan, coalesce(premium_translate, false), translation_provider
    into v_plan, v_premium, v_user_prov
  from public.profiles where id = p_user_id;

  select value into v_settings from public.app_settings where key = 'translation';
  if v_settings is null then v_settings := '{"paid_provider":"gemini","free_source":"free"}'::jsonb; end if;

  v_is_premium := coalesce(v_premium, false) or coalesce(v_plan, 'free') <> 'free';
  v_provider   := coalesce(v_user_prov, v_settings->>'paid_provider', 'gemini');

  return jsonb_build_object(
    'is_premium',  v_is_premium,
    'provider',    v_provider,
    'free_source', coalesce(v_settings->>'free_source', 'free'),
    'plan',        coalesce(v_plan, 'free')
  );
end;
$$;
