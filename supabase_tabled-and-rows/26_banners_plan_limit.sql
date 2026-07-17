-- ============================================================
-- SQL Migration: Add banners/banner_images limit enforcement
-- ============================================================

-- 1. Recreate enforce_feature_limit_trigger with banners limit counting
CREATE OR REPLACE FUNCTION public.enforce_feature_limit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_feature_key text := COALESCE(TG_ARGV[0], TG_TABLE_NAME);
  v_store_id uuid;
  v_plan_id uuid;
  v_limit_type text;
  v_limit_config jsonb;
  v_limit_value bigint;
  v_current_count bigint;
  v_new_json jsonb;
BEGIN
  -- We only enforce limits on INSERT operations.
  -- Updates and deletions do not increase count, so they are always allowed.
  IF TG_OP <> 'INSERT' THEN
    RETURN COALESCE(NEW, OLD);
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

  -- Get active store subscription plan
  SELECT s.plan_id INTO v_plan_id
  FROM public.store_subscriptions s
  WHERE s.store_id = v_store_id AND s.status = 'active'
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get limit config for this feature and plan
  SELECT fl.limit_type, fl.limit_config INTO v_limit_type, v_limit_config
  FROM public.plan_features pf
  JOIN public.features f ON f.id = pf.feature_id
  LEFT JOIN public.feature_limits fl ON fl.plan_feature_id = pf.id
  WHERE pf.plan_id = v_plan_id AND f.key = lower(v_feature_key)
  LIMIT 1;

  IF v_limit_type IS NULL AND v_limit_config IS NULL THEN
    RETURN NEW;
  END IF;

  -- Evaluate if feature is disabled
  IF COALESCE(v_limit_config->>'mode', '') = 'disabled' OR COALESCE(v_limit_type, '') = 'disabled' THEN
    RAISE EXCEPTION 'هذه الميزة غير متوفرة في باقتك الحالية.';
  END IF;

  -- Get current count directly from table for absolute accuracy
  IF lower(v_feature_key) = 'products' THEN
    SELECT COUNT(*) INTO v_current_count FROM public.products WHERE store_id = v_store_id;
  ELSIF lower(v_feature_key) = 'branches' THEN
    SELECT COUNT(*) INTO v_current_count FROM public.branches WHERE store_id = v_store_id;
  ELSIF lower(v_feature_key) = 'coupons' THEN
    SELECT COUNT(*) INTO v_current_count FROM public.coupons WHERE store_id = v_store_id;
  ELSIF lower(v_feature_key) = 'employees' OR lower(v_feature_key) = 'staff_users' THEN
    SELECT COUNT(*) INTO v_current_count FROM public.user_roles WHERE store_id = v_store_id;
  ELSIF lower(v_feature_key) = 'banners' OR lower(v_feature_key) = 'banner_images' THEN
    SELECT COUNT(*) INTO v_current_count FROM public.banners WHERE store_id = v_store_id;
  ELSE
    -- For transactional features (e.g. WhatsApp notifications), fallback to check_feature_limit
    DECLARE
      v_res record;
    BEGIN
      SELECT allowed, reason INTO v_res FROM public.check_feature_limit(v_store_id, v_feature_key, 1);
      IF NOT v_res.allowed THEN
        RAISE EXCEPTION 'تجاوزت الحد الأقصى للميزة: %', v_res.reason;
      END IF;
    END;
    RETURN NEW;
  END IF;

  v_limit_value := NULLIF((v_limit_config->>'max_value')::bigint, NULL);
  IF v_limit_value IS NOT NULL AND v_current_count >= v_limit_value THEN
    RAISE EXCEPTION 'لقد وصلت للحد الأقصى المسموح به لهذه الميزة في باقتك الحالية (% من %)', v_current_count, v_limit_value;
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Create the Trigger on the banners table
DROP TRIGGER IF EXISTS tr_enforce_banner_limit ON public.banners;
CREATE TRIGGER tr_enforce_banner_limit
  BEFORE INSERT ON public.banners
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_feature_limit_trigger('banner_images');
