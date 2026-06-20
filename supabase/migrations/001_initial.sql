-- ============================================================
-- ShadowEcho - Supabase Schema v1
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================================

-- ── 1. PROFILES (auto-created on signup via trigger) ────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  full_name   TEXT,
  avatar_url  TEXT,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- ── 2. PLANS (config table, readable by all authenticated users) ─
CREATE TABLE IF NOT EXISTS public.plans (
  name               TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  daily_translations INT  NOT NULL DEFAULT 20,
  daily_ai_calls     INT  NOT NULL DEFAULT 10,
  price_usd          DECIMAL(10,2) NOT NULL DEFAULT 0,
  features           JSONB NOT NULL DEFAULT '[]'
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans_select_all" ON public.plans FOR SELECT TO authenticated USING (true);

INSERT INTO public.plans (name, display_name, daily_translations, daily_ai_calls, price_usd, features)
VALUES
  ('free',     'Free',     20,    10,   0,     '["20 translations/day","10 AI queries/day","Basic shadowing"]'),
  ('basic',    'Basic',    200,   100,  4.99,  '["200 translations/day","100 AI queries/day","All features"]'),
  ('pro',      'Pro',      2000,  1000, 9.99,  '["2000 translations/day","1000 AI queries/day","Priority support"]'),
  ('lifetime', 'Lifetime', 99999, 99999,49.99, '["Unlimited translations","Unlimited AI","Lifetime access","All future features"]')
ON CONFLICT (name) DO NOTHING;

-- ── 3. SUBSCRIPTIONS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                 TEXT NOT NULL DEFAULT 'free',
  status               TEXT NOT NULL DEFAULT 'active', -- active | canceled | expired | trialing
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_select_own" ON public.subscriptions FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON public.subscriptions (user_id);

-- ── 4. USAGE (daily counters per user) ──────────────────────
CREATE TABLE IF NOT EXISTS public.usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date              DATE NOT NULL DEFAULT CURRENT_DATE,
  translation_count INT  NOT NULL DEFAULT 0,
  ai_count          INT  NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, date)
);

ALTER TABLE public.usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "usage_select_own" ON public.usage FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_usage_user_date ON public.usage (user_id, date);

-- ── 5. TRIGGER: create profile + free subscription on signup ─
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, plan)
  VALUES (NEW.id, NEW.email, 'free')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (user_id, plan, status, current_period_start, current_period_end)
  VALUES (NEW.id, 'free', 'active', NOW(), NOW() + INTERVAL '100 years')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 6. RPC: check quota and atomically increment usage ───────
-- Called by Cloudflare Worker with service-role key (bypasses RLS)
CREATE OR REPLACE FUNCTION public.check_and_increment_usage(
  p_user_id UUID,
  p_type    TEXT  -- 'translation' | 'ai'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_plan          TEXT;
  v_daily_limit   INT;
  v_current_count INT := 0;
  v_date          DATE := CURRENT_DATE;
BEGIN
  -- Active plan (latest subscription wins)
  SELECT s.plan INTO v_plan
  FROM public.subscriptions s
  WHERE s.user_id = p_user_id AND s.status = 'active'
  ORDER BY s.created_at DESC LIMIT 1;

  IF v_plan IS NULL THEN v_plan := 'free'; END IF;

  -- Plan quota
  IF p_type = 'translation' THEN
    SELECT daily_translations INTO v_daily_limit FROM public.plans WHERE name = v_plan;
  ELSE
    SELECT daily_ai_calls INTO v_daily_limit FROM public.plans WHERE name = v_plan;
  END IF;

  IF v_daily_limit IS NULL THEN v_daily_limit := 20; END IF;

  -- Today's usage
  IF p_type = 'translation' THEN
    SELECT COALESCE(translation_count, 0) INTO v_current_count
    FROM public.usage WHERE user_id = p_user_id AND date = v_date;
  ELSE
    SELECT COALESCE(ai_count, 0) INTO v_current_count
    FROM public.usage WHERE user_id = p_user_id AND date = v_date;
  END IF;

  IF v_current_count IS NULL THEN v_current_count := 0; END IF;

  -- Quota check
  IF v_current_count >= v_daily_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'plan',    v_plan,
      'used',    v_current_count,
      'limit',   v_daily_limit
    );
  END IF;

  -- Atomic increment
  INSERT INTO public.usage (user_id, date, translation_count, ai_count)
  VALUES (
    p_user_id, v_date,
    CASE WHEN p_type = 'translation' THEN 1 ELSE 0 END,
    CASE WHEN p_type = 'ai'          THEN 1 ELSE 0 END
  )
  ON CONFLICT (user_id, date) DO UPDATE SET
    translation_count = usage.translation_count + CASE WHEN p_type = 'translation' THEN 1 ELSE 0 END,
    ai_count          = usage.ai_count          + CASE WHEN p_type = 'ai'          THEN 1 ELSE 0 END,
    updated_at        = NOW();

  RETURN jsonb_build_object(
    'allowed', true,
    'plan',    v_plan,
    'used',    v_current_count + 1,
    'limit',   v_daily_limit
  );
END;
$$;

-- ── 7. ADMIN: upgrade a user's plan (service-role only) ─────
CREATE OR REPLACE FUNCTION public.admin_set_plan(
  p_user_id UUID,
  p_plan    TEXT,
  p_months  INT DEFAULT 12
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.profiles SET plan = p_plan, updated_at = NOW() WHERE id = p_user_id;

  INSERT INTO public.subscriptions (user_id, plan, status, current_period_start, current_period_end)
  VALUES (p_user_id, p_plan, 'active', NOW(),
    CASE WHEN p_plan = 'lifetime' THEN NOW() + INTERVAL '100 years'
         ELSE NOW() + (p_months || ' months')::INTERVAL END)
  ON CONFLICT DO NOTHING;

  UPDATE public.subscriptions
  SET plan = p_plan, status = 'active',
      current_period_start = NOW(),
      current_period_end = CASE WHEN p_plan = 'lifetime' THEN NOW() + INTERVAL '100 years'
                                ELSE NOW() + (p_months || ' months')::INTERVAL END,
      updated_at = NOW()
  WHERE user_id = p_user_id
    AND id = (SELECT id FROM public.subscriptions WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 1);
END;
$$;
