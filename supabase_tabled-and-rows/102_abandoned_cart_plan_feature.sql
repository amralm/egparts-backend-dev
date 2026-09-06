-- Migration 102: Add abandoned_cart_recovery to platform features and plan entitlements

INSERT INTO public.features (key, display_name, description)
VALUES (
  'abandoned_cart_recovery',
  'استرجاع السلات المتروكة (واتساب)',
  'إرسال رسائل تذكير آلية للعملاء الذين تركوا سلات الشراء عبر واتساب المتجر'
)
ON CONFLICT (key) DO UPDATE 
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;

INSERT INTO public.plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM public.plans p
CROSS JOIN public.features f
WHERE f.key = 'abandoned_cart_recovery'
ON CONFLICT (plan_id, feature_id) DO NOTHING;

INSERT INTO public.feature_limits (plan_feature_id, limit_type, limit_config)
SELECT 
  pf.id,
  'boolean',
  jsonb_build_object('enabled', CASE WHEN p.code IN ('growth', 'scale', 'enterprise') THEN true ELSE false END)
FROM public.plan_features pf
JOIN public.plans p ON p.id = pf.plan_id
JOIN public.features f ON f.id = pf.feature_id
WHERE f.key = 'abandoned_cart_recovery'
ON CONFLICT (plan_feature_id, limit_type) DO UPDATE
SET limit_config = EXCLUDED.limit_config;
