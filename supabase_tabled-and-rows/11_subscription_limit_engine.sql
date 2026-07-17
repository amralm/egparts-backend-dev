-- RC3 Subscription Limit Engine V2
-- Generic feature limit enforcement across database, backend, and frontend.
-- Added: Atomicity, Reservations, Idempotency, Caching, Triggers

CREATE TABLE IF NOT EXISTS public.features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  display_name text,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.plan_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (plan_id, feature_id)
);

CREATE TABLE IF NOT EXISTS public.feature_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_feature_id uuid NOT NULL,
  limit_type text NOT NULL DEFAULT 'count',
  limit_config jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (plan_feature_id, limit_type)
);

CREATE TABLE IF NOT EXISTS public.feature_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  feature_key text NOT NULL,
  usage bigint NOT NULL DEFAULT 0,
  limit_value bigint,
  last_updated timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Ensure the new period columns exist (for V2 upgrade)
ALTER TABLE public.feature_usage 
  ADD COLUMN IF NOT EXISTS period text NOT NULL DEFAULT 'lifetime',
  ADD COLUMN IF NOT EXISTS period_start timestamptz DEFAULT to_timestamp(0),
  ADD COLUMN IF NOT EXISTS period_end timestamptz;

-- Ensure the new UNIQUE constraint exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'feature_usage_store_id_feature_key_period_period_start_key'
    ) THEN
        ALTER TABLE public.feature_usage 
          ADD CONSTRAINT feature_usage_store_id_feature_key_period_period_start_key 
          UNIQUE (store_id, feature_key, period, period_start);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_feature_usage_store_feature_period
  ON public.feature_usage (store_id, feature_key, period, period_start);

CREATE TABLE IF NOT EXISTS public.feature_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  feature_key text NOT NULL,
  amount integer NOT NULL DEFAULT 1,
  idempotency_key text UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_reservations_store_feature 
  ON public.feature_reservations (store_id, feature_key);

CREATE OR REPLACE FUNCTION public.infer_feature_period_type(p_feature_key text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
SELECT CASE
  WHEN lower(p_feature_key) IN (
    'whatsapp_messages_month', 'otp_messages_month', 'email_messages_month', 'push_notifications_month',
    'ai_requests_month', 'analytics_exports', 'report_generation', 'forecast_jobs'
  ) THEN 'monthly'
  WHEN lower(p_feature_key) IN (
    'storage_bytes', 'uploaded_images', 'uploaded_files', 'banner_images', 'logos'
  ) THEN 'lifetime'
  ELSE 'lifetime'
END;
$$;

CREATE OR REPLACE FUNCTION public.check_feature_limit(
  p_store_id uuid,
  p_feature_key text,
  p_requested_increment integer DEFAULT 1
)
RETURNS TABLE (
  allowed boolean,
  remaining bigint,
  limit_value bigint,
  usage bigint,
  reason text,
  feature_key text,
  limit_type text,
  period_type text,
  is_unlimited boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_feature_id uuid;
  v_plan_id uuid;
  v_sub_status text;
  v_limit_type text;
  v_limit_config jsonb;
  v_limit_value bigint;
  v_period_type text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_usage bigint := 0;
  v_reserved bigint := 0;
  v_allowed boolean := true;
  v_remaining bigint;
  v_reason text := NULL;
  v_increment int := COALESCE(p_requested_increment, 1);
  v_now timestamptz := now();
BEGIN
  IF p_store_id IS NULL OR COALESCE(p_feature_key, '') = '' THEN
    RETURN QUERY SELECT true, NULL::bigint, NULL::bigint, 0::bigint, 'Missing store or feature key', NULL::text, NULL::text, 'lifetime', true;
    RETURN;
  END IF;

  -- 1. Ensure Feature Exists
  SELECT id INTO v_feature_id
  FROM public.features
  WHERE key = lower(p_feature_key)
  LIMIT 1;

  IF v_feature_id IS NULL THEN
    INSERT INTO public.features (key, display_name)
    VALUES (lower(p_feature_key), lower(p_feature_key))
    ON CONFLICT (key) DO NOTHING;
    SELECT id INTO v_feature_id
    FROM public.features
    WHERE key = lower(p_feature_key)
    LIMIT 1;
  END IF;

  -- 2. Check Subscription & Status
  SELECT s.plan_id, s.status INTO v_plan_id, v_sub_status
  FROM public.store_subscriptions s
  WHERE s.store_id = p_store_id
  ORDER BY s.status = 'active' DESC, s.created_at DESC
  LIMIT 1;

  IF v_plan_id IS NULL THEN
    RETURN QUERY SELECT true, NULL::bigint, NULL::bigint, 0::bigint, 'No active plan found', lower(p_feature_key), NULL::text, 'lifetime', true;
    RETURN;
  END IF;

  IF v_sub_status IN ('expired', 'canceled') AND v_increment > 0 THEN
    RETURN QUERY SELECT false, 0::bigint, 0::bigint, 0::bigint, 'Subscription Expired', lower(p_feature_key), NULL::text, 'lifetime', false;
    RETURN;
  END IF;

  -- 3. Get Limits for Plan
  SELECT fl.limit_type, fl.limit_config
    INTO v_limit_type, v_limit_config
  FROM public.plan_features pf
  LEFT JOIN public.feature_limits fl ON fl.plan_feature_id = pf.id
  WHERE pf.plan_id = v_plan_id
    AND pf.feature_id = v_feature_id
  ORDER BY fl.created_at DESC
  LIMIT 1;

  IF v_limit_type IS NULL AND v_limit_config IS NULL THEN
    RETURN QUERY SELECT true, NULL::bigint, NULL::bigint, 0::bigint, 'No limit configured for this plan', lower(p_feature_key), NULL::text, 'lifetime', true;
    RETURN;
  END IF;

  v_period_type := COALESCE((v_limit_config->>'period_type')::text, (v_limit_config->>'period')::text, public.infer_feature_period_type(lower(p_feature_key)));

  IF v_period_type = 'monthly' THEN
    v_period_start := date_trunc('month', v_now);
    v_period_end := v_period_start + interval '1 month';
  ELSIF v_period_type = 'daily' THEN
    v_period_start := date_trunc('day', v_now);
    v_period_end := v_period_start + interval '1 day';
  ELSE
    v_period_start := to_timestamp(0);
    v_period_end := '9999-12-31 23:59:59+00'::timestamptz;
  END IF;

  -- 4. Get Current Usage with Atomic Locking (if modifying)
  IF v_increment > 0 THEN
    -- Ensure row exists so we can lock it
    INSERT INTO public.feature_usage (store_id, feature_key, period, period_start, period_end, usage)
    VALUES (p_store_id, lower(p_feature_key), v_period_type, v_period_start, v_period_end, 0)
    ON CONFLICT (store_id, feature_key, period, period_start) DO NOTHING;

    SELECT usage INTO v_usage
    FROM public.feature_usage
    WHERE store_id = p_store_id
      AND feature_key = lower(p_feature_key)
      AND period = v_period_type
      AND period_start = v_period_start
    FOR UPDATE;
  ELSE
    SELECT usage INTO v_usage
    FROM public.feature_usage
    WHERE store_id = p_store_id
      AND feature_key = lower(p_feature_key)
      AND period = v_period_type
      AND period_start = v_period_start;
  END IF;

  IF v_usage IS NULL THEN
    v_usage := 0;
  END IF;

  -- 5. Calculate active reservations
  SELECT COALESCE(SUM(amount), 0) INTO v_reserved
  FROM public.feature_reservations
  WHERE store_id = p_store_id
    AND feature_key = lower(p_feature_key)
    AND expires_at > v_now;

  -- 6. Evaluate Limits
  IF COALESCE((v_limit_config->>'mode')::text, '') = 'disabled' OR COALESCE(v_limit_type, '') = 'disabled' THEN
    v_allowed := false;
    v_remaining := 0;
    v_limit_value := 0;
    v_reason := 'Feature disabled by current plan';
  ELSIF COALESCE((v_limit_config->>'mode')::text, '') = 'unlimited' OR COALESCE(v_limit_type, '') = 'unlimited' THEN
    v_allowed := true;
    v_remaining := NULL;
    v_limit_value := NULL;
    v_reason := 'Unlimited by current plan';
  ELSE
    v_limit_value := NULLIF((v_limit_config->>'max_value')::bigint, NULL);
    IF v_limit_value IS NULL THEN
      v_allowed := true;
      v_remaining := NULL;
      v_reason := 'Unlimited by current plan';
    ELSE
      v_remaining := v_limit_value - (v_usage + v_reserved + v_increment);
      v_allowed := v_remaining >= 0;
      v_reason := CASE WHEN v_allowed THEN NULL ELSE 'Feature limit reached for this plan' END;
    END IF;
  END IF;

  IF v_sub_status IN ('expired', 'canceled') THEN
    v_allowed := false;
    v_reason := 'Subscription Expired';
  END IF;

  -- 7. Update Usage if allowed and increment > 0
  IF v_allowed AND v_increment > 0 THEN
    UPDATE public.feature_usage
    SET usage = usage + v_increment,
        limit_value = v_limit_value,
        last_updated = v_now
    WHERE store_id = p_store_id
      AND feature_key = lower(p_feature_key)
      AND period = v_period_type
      AND period_start = v_period_start
    RETURNING usage INTO v_usage;
  END IF;

  RETURN QUERY SELECT
    v_allowed,
    v_remaining,
    v_limit_value,
    v_usage,
    v_reason,
    lower(p_feature_key),
    v_limit_type,
    v_period_type,
    (v_limit_value IS NULL);
END;
$$;

-- Reservation RPCs

CREATE OR REPLACE FUNCTION public.reserve_feature_usage(
  p_store_id uuid,
  p_feature_key text,
  p_amount integer,
  p_idempotency_key text,
  p_ttl_minutes integer DEFAULT 5
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_allowed boolean;
  v_exists boolean;
  v_remaining bigint;
  v_is_unlimited boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT true INTO v_exists FROM public.feature_reservations WHERE idempotency_key = p_idempotency_key;
    IF v_exists THEN
      RETURN true; -- Idempotency hit
    END IF;
  END IF;

  SELECT allowed, remaining, is_unlimited 
    INTO v_allowed, v_remaining, v_is_unlimited 
  FROM public.check_feature_limit(p_store_id, p_feature_key, 0) LIMIT 1;
  
  IF NOT v_is_unlimited THEN 
     IF v_remaining < p_amount THEN
       RETURN false;
     END IF;
  END IF;

  IF NOT v_allowed THEN
    RETURN false;
  END IF;

  INSERT INTO public.feature_reservations (store_id, feature_key, amount, idempotency_key, expires_at)
  VALUES (p_store_id, lower(p_feature_key), p_amount, p_idempotency_key, now() + (p_ttl_minutes || ' minutes')::interval);

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_feature_usage(
  p_idempotency_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_res record;
  v_allowed boolean;
BEGIN
  -- Lock the reservation row
  SELECT * INTO v_res FROM public.feature_reservations WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false; 
  END IF;

  -- Commit the usage permanently
  SELECT allowed INTO v_allowed FROM public.check_feature_limit(v_res.store_id, v_res.feature_key, v_res.amount) LIMIT 1;
  
  -- Remove the reservation
  DELETE FROM public.feature_reservations WHERE id = v_res.id;
  RETURN v_allowed;
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_feature_usage(
  p_idempotency_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.feature_reservations WHERE idempotency_key = p_idempotency_key;
  RETURN FOUND;
END;
$$;

-- Trigger Function

CREATE OR REPLACE FUNCTION public.enforce_feature_limit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_feature_key text := COALESCE(TG_ARGV[0], TG_TABLE_NAME);
  v_requested_increment int := COALESCE(TG_ARGV[1]::int, 1);
  v_store_id uuid;
  v_result record;
  v_new_json jsonb;
  v_old_json jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_json := to_jsonb(OLD);
    IF v_old_json ? 'store_id' THEN
      v_store_id := (v_old_json->>'store_id')::uuid;
    ELSIF v_old_json ? 'branch_id' THEN
      SELECT store_id INTO v_store_id FROM public.branches WHERE id = (v_old_json->>'branch_id')::uuid;
    END IF;
    RETURN OLD;
  END IF;

  v_new_json := to_jsonb(NEW);
  IF v_new_json ? 'store_id' THEN
    v_store_id := (v_new_json->>'store_id')::uuid;
  ELSIF v_new_json ? 'branch_id' THEN
    SELECT store_id INTO v_store_id FROM public.branches WHERE id = (v_new_json->>'branch_id')::uuid;
  END IF;

  IF v_store_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_result
  FROM public.check_feature_limit(v_store_id, v_feature_key, v_requested_increment);

  IF NOT v_result.allowed THEN
    RAISE EXCEPTION 'Feature limit exceeded for %: %', v_feature_key, v_result.reason;
  END IF;

  RETURN NEW;
END;
$$;

-- Apply Triggers
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_feature_limit_trigger') THEN
      CREATE TRIGGER products_feature_limit_trigger
      BEFORE INSERT OR UPDATE ON public.products
      FOR EACH ROW EXECUTE FUNCTION public.enforce_feature_limit_trigger('products', 1);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'branches') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'branches_feature_limit_trigger') THEN
      CREATE TRIGGER branches_feature_limit_trigger
      BEFORE INSERT OR UPDATE ON public.branches
      FOR EACH ROW EXECUTE FUNCTION public.enforce_feature_limit_trigger('branches', 1);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'employees') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employees_feature_limit_trigger') THEN
      CREATE TRIGGER employees_feature_limit_trigger
      BEFORE INSERT OR UPDATE ON public.employees
      FOR EACH ROW EXECUTE FUNCTION public.enforce_feature_limit_trigger('employees', 1);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'categories') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'categories_feature_limit_trigger') THEN
      CREATE TRIGGER categories_feature_limit_trigger
      BEFORE INSERT OR UPDATE ON public.categories
      FOR EACH ROW EXECUTE FUNCTION public.enforce_feature_limit_trigger('categories', 1);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coupons') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'coupons_feature_limit_trigger') THEN
      CREATE TRIGGER coupons_feature_limit_trigger
      BEFORE INSERT OR UPDATE ON public.coupons
      FOR EACH ROW EXECUTE FUNCTION public.enforce_feature_limit_trigger('coupons', 1);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'warehouses') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'warehouses_feature_limit_trigger') THEN
      CREATE TRIGGER warehouses_feature_limit_trigger
      BEFORE INSERT OR UPDATE ON public.warehouses
      FOR EACH ROW EXECUTE FUNCTION public.enforce_feature_limit_trigger('warehouses', 1);
    END IF;
  END IF;
END $$;
