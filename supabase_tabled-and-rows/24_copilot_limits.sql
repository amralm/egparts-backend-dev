-- 1. Create or update infer_feature_period_type function to support daily limits
CREATE OR REPLACE FUNCTION public.infer_feature_period_type(p_feature_key text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
SELECT CASE
  WHEN lower(p_feature_key) IN (
    'api_requests_day', 'copilot_messages_day'
  ) THEN 'daily'
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

-- 2. Insert copilot_messages_day feature
INSERT INTO public.features (key, display_name, description) VALUES
('copilot_messages_day', 'حد رسائل كوبايلوت اليومي', 'عدد رسائل الشات اليومية المسموح بها مع مساعد النمو الذكي')
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;

-- 3. Link copilot_messages_day to all plans
INSERT INTO public.plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM public.plans p
CROSS JOIN public.features f
WHERE f.key = 'copilot_messages_day'
ON CONFLICT (plan_id, feature_id) DO NOTHING;

-- 4. Seed limit values per plan
-- Starter: 5 messages/day
-- Growth: 50 messages/day
-- Scale: 200 messages/day
-- Enterprise: Unlimited (-1)
WITH limit_seed(plan_code, feature_key, limit_type, limit_config) AS (
  VALUES
  ('starter', 'copilot_messages_day', 'count', '{"max_value":5}'::jsonb),
  ('growth', 'copilot_messages_day', 'count', '{"max_value":50}'::jsonb),
  ('scale', 'copilot_messages_day', 'count', '{"max_value":200}'::jsonb),
  ('enterprise', 'copilot_messages_day', 'count', '{"max_value":-1}'::jsonb)
)
INSERT INTO public.feature_limits (plan_feature_id, limit_type, limit_config)
SELECT pf.id, ls.limit_type, ls.limit_config
FROM limit_seed ls
JOIN public.plans p ON p.code = ls.plan_code
JOIN public.features f ON f.key = ls.feature_key
JOIN public.plan_features pf ON pf.plan_id = p.id AND pf.feature_id = f.id
ON CONFLICT (plan_feature_id, limit_type) DO UPDATE SET limit_config = EXCLUDED.limit_config;

-- 5. Create self-healing image usage sync helper
CREATE OR REPLACE FUNCTION public.sync_store_image_usage(p_store_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_products_count bigint;
  v_banners_count bigint;
  v_settings_count bigint;
  v_total bigint;
  v_limit bigint;
BEGIN
  -- Count product main images
  SELECT count(*) INTO v_products_count
  FROM public.products
  WHERE store_id = p_store_id AND is_active = true AND is_deleted = false AND image IS NOT NULL AND image <> '';
  
  -- Count banners
  SELECT count(*) INTO v_banners_count
  FROM public.banners
  WHERE store_id = p_store_id AND is_active = true;

  -- Count logo/favicon in settings
  SELECT (CASE WHEN logo_url IS NOT NULL AND logo_url <> '' THEN 1 ELSE 0 END) +
         (CASE WHEN favicon_url IS NOT NULL AND favicon_url <> '' THEN 1 ELSE 0 END) INTO v_settings_count
  FROM public.site_settings
  WHERE store_id = p_store_id;

  v_total := COALESCE(v_products_count, 0) + COALESCE(v_banners_count, 0) + COALESCE(v_settings_count, 0);

  -- Fetch current limit
  SELECT max_value INTO v_limit
  FROM public.feature_limits fl
  JOIN public.plan_features pf ON pf.id = fl.plan_feature_id
  JOIN public.features f ON f.id = pf.feature_id
  JOIN public.store_subscriptions ss ON ss.plan_id = pf.plan_id
  WHERE ss.store_id = p_store_id AND f.key = 'uploaded_images' AND ss.status = 'active'
  ORDER BY ss.created_at DESC LIMIT 1;

  -- Upsert into feature_usage
  INSERT INTO public.feature_usage (store_id, feature_key, usage, limit_value, period, period_start)
  VALUES (p_store_id, 'uploaded_images', v_total, v_limit, 'lifetime', to_timestamp(0))
  ON CONFLICT (store_id, feature_key, period, period_start)
  DO UPDATE SET usage = v_total, limit_value = v_limit, last_updated = now();

  RETURN v_total;
END;
$$;

-- 6. Immediately trigger synchronization for all existing stores
DO $$
DECLARE
  v_store_id uuid;
BEGIN
  FOR v_store_id IN SELECT id FROM public.stores LOOP
    PERFORM public.sync_store_image_usage(v_store_id);
  END LOOP;
END $$;
