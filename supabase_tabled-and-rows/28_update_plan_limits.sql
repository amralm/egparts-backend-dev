-- ============================================================
-- SQL Migration: Update daily copilot and banner limits per plan
-- ============================================================

-- 1. Ensure banner_images and copilot_messages_day features exist
INSERT INTO public.features (key, display_name, description) VALUES
('copilot_messages_day', 'حد رسائل كوبايلوت اليومي', 'عدد رسائل الشات اليومية المسموح بها مع مساعد النمو الذكي'),
('banner_images', 'الحد الأقصى للبنرات', 'عدد البنرات والعروض الترويجية المسموح بإضافتها في الصفحة الرئيسية')
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;

-- 2. Link features to all plans
INSERT INTO public.plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM public.plans p
CROSS JOIN public.features f
WHERE f.key IN ('banner_images', 'copilot_messages_day')
ON CONFLICT (plan_id, feature_id) DO NOTHING;

-- 3. Seed and update limits for all plans
WITH limit_seed(plan_code, feature_key, limit_type, limit_config) AS (
  VALUES
  -- Starter
  ('starter', 'copilot_messages_day', 'count', '{"max_value":5}'::jsonb),
  ('starter', 'banner_images', 'count', '{"max_value":3}'::jsonb),
  
  -- Growth
  ('growth', 'copilot_messages_day', 'count', '{"max_value":50}'::jsonb),
  ('growth', 'banner_images', 'count', '{"max_value":10}'::jsonb),
  
  -- Scale
  ('scale', 'copilot_messages_day', 'count', '{"max_value":200}'::jsonb),
  ('scale', 'banner_images', 'count', '{"max_value":30}'::jsonb),
  
  -- Enterprise
  ('enterprise', 'copilot_messages_day', 'count', '{"max_value":-1}'::jsonb),
  ('enterprise', 'banner_images', 'count', '{"max_value":-1}'::jsonb)
)
INSERT INTO public.feature_limits (plan_feature_id, limit_type, limit_config)
SELECT pf.id, ls.limit_type, ls.limit_config
FROM limit_seed ls
JOIN public.plans p ON p.code = ls.plan_code
JOIN public.features f ON f.key = ls.feature_key
JOIN public.plan_features pf ON pf.plan_id = p.id AND pf.feature_id = f.id
ON CONFLICT (plan_feature_id, limit_type) DO UPDATE SET limit_config = EXCLUDED.limit_config;
