-- Drop old cached function signatures to force Postgres to compile them against the new schema
DROP FUNCTION IF EXISTS public.check_feature_limit(uuid, text, integer);
DROP FUNCTION IF EXISTS public.reserve_feature_usage(uuid, text, integer, text, integer);

-- Recreate check_feature_limit with renamed output column to completely eliminate the name conflict
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
  out_feature_key text, -- Renamed from feature_key to avoid name conflict with table columns
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
    INSERT INTO public.feature_usage (store_id, feature_key, period, period_start, period_end, usage_count)
    VALUES (p_store_id, lower(p_feature_key), v_period_type, v_period_start, v_period_end, 0)
    ON CONFLICT (store_id, feature_key, period, period_start) DO NOTHING;

    SELECT usage_count INTO v_usage
    FROM public.feature_usage
    WHERE store_id = p_store_id
      AND feature_key = lower(p_feature_key)
      AND period = v_period_type
      AND period_start = v_period_start
    FOR UPDATE;
  ELSE
    SELECT usage_count INTO v_usage
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
    SET usage_count = usage_count + v_increment,
        updated_at = v_now
    WHERE store_id = p_store_id
      AND feature_key = lower(p_feature_key)
      AND period = v_period_type
      AND period_start = v_period_start
    RETURNING usage_count INTO v_usage;
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


-- Recreate reserve_feature_usage
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
      RETURN true;
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
