-- ============================================================================
-- 004_api_management.sql — Catalog model đa nguồn + định tuyến fallback + log usage.
-- Quản lý API kiểu 9Router: thêm/bật/tắt model theo provider ngay trong Admin,
-- /transcribe + /score-ai + /translate chọn model+key theo catalog (có fallback),
-- mỗi lượt gọi ghi vào api_usage_events để vẽ dashboard.
-- Idempotent: chạy lại an toàn. Chỉ Worker (service_role) đọc/ghi.
-- Chạy trong Supabase SQL Editor SAU 001 + 002 + 003.
-- ============================================================================

-- ───────── 1. Catalog model (mỗi model thuộc 1 provider + 1 năng lực) ─────────
-- capability: 'translate' | 'stt' (ghi âm) | 'score' (chấm phát âm) | 'chat'
-- Chuỗi fallback của 1 capability = các model enabled, sắp theo priority ASC.
create table if not exists public.api_models (
  id            uuid primary key default gen_random_uuid(),
  provider_id   text not null references public.api_providers(id) on delete cascade,
  model_id      text not null,                 -- vd 'whisper-large-v3-turbo', 'gemini-2.0-flash'
  display_name  text,
  capability    text not null,                 -- translate | stt | score | chat
  enabled       boolean not null default true,
  priority      int not null default 100,      -- nhỏ hơn = ưu tiên trước trong cùng capability
  cost_per_mtok numeric not null default 0,    -- $ / 1M token (ước tính — cho dashboard)
  notes         text,
  created_at    timestamptz not null default now(),
  unique (provider_id, model_id, capability)
);
create index if not exists idx_api_models_cap on public.api_models(capability, enabled, priority);
alter table public.api_models enable row level security; -- không policy → chỉ service_role

-- ───────── 2. RPC: chuỗi model hiệu lực cho 1 capability (đã lọc provider bật) ─────────
-- Trả JSON [{provider_id, model_id, cost_per_mtok}] theo priority. Worker lặp để fallback.
create or replace function public.route_models(p_capability text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_id', m.provider_id,
           'model_id',    m.model_id,
           'cost_per_mtok', m.cost_per_mtok
         ) order by m.priority asc, m.created_at asc), '[]'::jsonb)
  from public.api_models m
  join public.api_providers p on p.id = m.provider_id
  where m.capability = p_capability
    and m.enabled = true
    and p.enabled = true;
$$;

-- ───────── 3. RPC: ghi 1 sự kiện usage (Worker gọi sau mỗi lượt, qua ctx.waitUntil) ─────────
create or replace function public.log_usage(
  p_provider_id text,
  p_endpoint    text,
  p_model       text    default null,
  p_user_id     uuid    default null,
  p_key_id      uuid    default null,
  p_units       numeric default 0,
  p_tokens_in   bigint  default 0,
  p_tokens_out  bigint  default 0,
  p_success     boolean default true,
  p_status      int     default null,
  p_latency_ms  int     default null,
  p_est_cost    numeric default 0
)
returns void language sql security definer set search_path = public as $$
  insert into public.api_usage_events
    (provider_id, endpoint, model, user_id, key_id, units, tokens_in, tokens_out, success, status, latency_ms, est_cost)
  values
    (p_provider_id, p_endpoint, p_model, p_user_id, p_key_id, p_units, p_tokens_in, p_tokens_out, p_success, p_status, p_latency_ms, p_est_cost);
$$;

-- ───────── 4. RPC: tổng hợp usage N ngày gần nhất theo provider (cho dashboard) ─────────
create or replace function public.usage_summary(p_days int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(t) order by (t).calls desc), '[]'::jsonb)
  from (
    select provider_id,
           count(*)::bigint                              as calls,
           coalesce(sum(case when success then 0 else 1 end),0)::bigint as errors,
           coalesce(sum(tokens_in),0)::bigint            as tokens_in,
           coalesce(sum(tokens_out),0)::bigint           as tokens_out,
           round(coalesce(sum(est_cost),0)::numeric, 4)  as est_cost
    from public.api_usage_events
    where ts >= now() - make_interval(days => greatest(p_days, 1))
    group by provider_id
  ) t;
$$;

-- ───────── 5. Seed model mặc định (giữ nguyên hành vi hiện tại của code) ─────────
-- Chỉ chèn khi provider tương ứng tồn tại; an toàn chạy lại (on conflict do nothing).
do $$
begin
  if to_regclass('public.api_providers') is not null then
    -- Đảm bảo provider Mistral tồn tại (003 có thể chưa chèn) trước khi seed model.
    insert into public.api_providers (id, display_name, kind, base_url, docs_url) values
      ('mistral', 'Mistral AI', 'api_key', 'https://api.mistral.ai', 'https://console.mistral.ai/api-keys')
    on conflict (id) do nothing;

    -- Ghi âm (STT): Groq Whisper turbo
    insert into public.api_models (provider_id, model_id, display_name, capability, priority, cost_per_mtok) values
      ('groq', 'whisper-large-v3-turbo', 'Whisper Large v3 Turbo', 'stt', 100, 0)
    on conflict (provider_id, model_id, capability) do nothing;

    -- Chấm phát âm (score): Groq Llama (primary) → Groq 8B → OpenRouter free
    insert into public.api_models (provider_id, model_id, display_name, capability, priority, cost_per_mtok) values
      ('groq',       'llama-3.3-70b-versatile', 'Llama 3.3 70B',        'score', 100, 0),
      ('groq',       'llama-3.1-8b-instant',    'Llama 3.1 8B Instant', 'score', 110, 0),
      ('openrouter', 'openai/gpt-oss-120b:free','GPT-OSS 120B (free)',  'score', 200, 0)
    on conflict (provider_id, model_id, capability) do nothing;

    -- Dịch (translate): theo provider admin chọn ở 003 (lấy model top-priority)
    insert into public.api_models (provider_id, model_id, display_name, capability, priority, cost_per_mtok) values
      ('gemini',     'gemini-2.0-flash',         'Gemini 2.0 Flash',    'translate', 100, 0),
      ('mistral',    'mistral-small-latest',     'Mistral Small',       'translate', 100, 0),
      ('openrouter', 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (free)', 'translate', 100, 0)
    on conflict (provider_id, model_id, capability) do nothing;

    -- DeepL không cần model id (dịch trực tiếp) — chèn 1 hàng đánh dấu để hiện trong catalog
    insert into public.api_models (provider_id, model_id, display_name, capability, priority, cost_per_mtok) values
      ('deepl', 'deepl', 'DeepL', 'translate', 100, 0)
    on conflict (provider_id, model_id, capability) do nothing;
  end if;
end $$;
