-- ============================================================================
-- 002_admin.sql — Bảng cho trang Admin (SPA tĩnh Cloudflare) + metering + thanh toán.
-- Idempotent: chạy lại an toàn. Chỉ Worker (service_role) đọc/ghi — RLS bật, KHÔNG policy
-- (anon/authenticated bị chặn hết; service_role bỏ qua RLS).
-- Chạy trong Supabase SQL Editor SAU 001_initial.sql.
-- ============================================================================

create extension if not exists pgcrypto;

-- ───────── Admin auth ─────────
create table if not exists admin_users (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  password_hash   text not null,                 -- pbkdf2$iter$salt$hash (băm ở Worker)
  role            text not null default 'owner',
  totp_secret     text,
  totp_enabled    boolean not null default false,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists admin_sessions (
  id          uuid primary key,                  -- jti của JWT
  admin_id    uuid not null references admin_users(id) on delete cascade,
  expires_at  timestamptz not null,
  revoked     boolean not null default false,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_admin_sessions_admin on admin_sessions(admin_id);

create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  admin_id    uuid,
  action      text not null,
  target_type text,
  target_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_log(created_at desc);

-- ───────── Quản lý API / key pool (kiểu 9router) ─────────
create table if not exists api_providers (
  id           text primary key,                 -- 'groq' | 'openrouter' | 'deepl' | 'gemini' | 'grok' | 'perplexity' ...
  display_name text not null,
  kind         text not null default 'api_key',  -- 'api_key' | 'session'
  enabled      boolean not null default true,
  base_url     text,
  docs_url     text,
  risk_note    text,
  created_at   timestamptz not null default now()
);

create table if not exists api_keys (
  id                     uuid primary key default gen_random_uuid(),
  provider_id            text not null references api_providers(id) on delete cascade,
  label                  text,
  secret_ref             text not null,          -- aesgcm:iv:ct (mã hoá bằng KEY_ENCRYPTION_KEY)
  status                 text not null default 'active', -- active | exhausted | disabled | error
  credit_requests_total  bigint not null default 0,
  credit_requests_used   bigint not null default 0,
  credit_tokens_total    bigint not null default 0,
  credit_tokens_used     bigint not null default 0,
  reset_interval         text not null default 'none',   -- none | daily | weekly
  resets_at              timestamptz,
  priority               int not null default 100,       -- nhỏ hơn = ưu tiên trước
  last_used_at           timestamptz,
  last_error             text,
  created_at             timestamptz not null default now()
);
create index if not exists idx_api_keys_provider on api_keys(provider_id, status, priority);

create table if not exists api_usage_events (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  provider_id  text,
  key_id       uuid,
  user_id      uuid,
  endpoint     text,
  model        text,
  run_location text,                              -- server | local | dedicated
  units        numeric default 0,
  tokens_in    bigint default 0,
  tokens_out   bigint default 0,
  success      boolean default true,
  status       int,
  latency_ms   int,
  est_cost     numeric default 0
);
create index if not exists idx_usage_events_ts on api_usage_events(ts desc);

create table if not exists usage_rollup_daily (
  date               date not null,
  user_id            uuid,                        -- null = tổng toàn hệ thống
  provider_id        text,
  server_stt_seconds numeric default 0,
  local_stt_seconds  numeric default 0,
  calls              bigint default 0,
  tokens             bigint default 0,
  est_cost           numeric default 0,
  primary key (date, user_id, provider_id)
);

-- ───────── Thanh toán ─────────
create table if not exists payments (
  id              uuid primary key default gen_random_uuid(),
  reference_code  text unique not null,           -- DE-xxxxxxx / VN-xxxxxxx
  user_id         uuid,
  method          text not null,                  -- iban | sepay | paypal
  plan            text,
  amount          numeric not null default 0,     -- đơn vị nhỏ nhất theo currency
  currency        text not null default 'EUR',    -- EUR | VND
  status          text not null default 'pending',-- pending | paid | canceled
  provider_txn_id text unique,                    -- dedupe webhook
  raw_payload     jsonb,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz
);
create index if not exists idx_payments_status on payments(status, created_at desc);

create table if not exists payout_config (
  id                   int primary key default 1,
  beneficiary_name     text,
  iban                 text,
  bic                  text,
  bank_name            text,
  paypal_link          text,
  sepay_account_number text,
  sepay_bank_code      text,
  iban_ref_prefix      text default 'DE-',
  sepay_ref_prefix     text default 'VN-',
  price_table          jsonb,                      -- { "pro": { "EUR": 999, "VND": 249000 }, ... }
  updated_at           timestamptz not null default now()
);

-- ───────── Mở rộng bảng có sẵn (an toàn nếu thiếu) ─────────
alter table if exists profiles add column if not exists model_source         text default 'server'; -- server | local | dedicated
alter table if exists profiles add column if not exists dedicated_api_key_id uuid;
alter table if exists profiles add column if not exists quota_override       jsonb;
alter table if exists profiles add column if not exists banned               boolean default false;

alter table if exists usage add column if not exists server_stt_seconds numeric default 0;
alter table if exists usage add column if not exists local_stt_seconds  numeric default 0;
alter table if exists usage add column if not exists tokens_in          bigint default 0;
alter table if exists usage add column if not exists tokens_out         bigint default 0;

-- ───────── RLS: bật, KHÔNG policy → chỉ service_role (Worker) truy cập ─────────
alter table admin_users        enable row level security;
alter table admin_sessions     enable row level security;
alter table audit_log          enable row level security;
alter table api_providers      enable row level security;
alter table api_keys           enable row level security;
alter table api_usage_events   enable row level security;
alter table usage_rollup_daily enable row level security;
alter table payments           enable row level security;
alter table payout_config      enable row level security;

-- ───────── Seed nhà cung cấp + cấu hình thanh toán mặc định ─────────
insert into api_providers (id, display_name, kind, base_url, docs_url, risk_note) values
  ('gemini',     'Google AI Studio (Gemini)', 'api_key', 'https://generativelanguage.googleapis.com', 'https://aistudio.google.com/apikey', null),
  ('groq',       'Groq',                       'api_key', 'https://api.groq.com',                       'https://console.groq.com/keys', null),
  ('openrouter', 'OpenRouter',                 'api_key', 'https://openrouter.ai/api',                  'https://openrouter.ai/keys', null),
  ('deepl',      'DeepL',                      'api_key', 'https://api-free.deepl.com',                 'https://www.deepl.com/pro-api', null),
  ('grok',       'xAI Grok',                   'api_key', 'https://api.x.ai',                           'https://x.ai/api', null),
  ('openai_session',     'ChatGPT (session)',   'session', null, null, 'Đăng nhập bằng session/cookie — vi phạm ToS, dễ hỏng, có thể bị khoá tài khoản. Mặc định TẮT, không phục vụ khách trả phí.'),
  ('gemini_session',     'Gemini (session)',    'session', null, null, 'Session/cookie — rủi ro cao (ToS). Mặc định TẮT.'),
  ('perplexity_session', 'Perplexity (session)','session', null, null, 'Session/cookie — rủi ro cao (ToS). Mặc định TẮT.')
on conflict (id) do nothing;

update api_providers set enabled = false where kind = 'session';

insert into payout_config (id, beneficiary_name, iban, bank_name, iban_ref_prefix, sepay_ref_prefix, price_table) values
  (1, 'Dong Huy Truong', 'BE05 9675 8234 0775', '', 'DE-', 'VN-',
   '{"basic":{"EUR":499,"VND":129000},"pro":{"EUR":999,"VND":249000},"lifetime":{"EUR":4999,"VND":1290000}}'::jsonb)
on conflict (id) do nothing;
