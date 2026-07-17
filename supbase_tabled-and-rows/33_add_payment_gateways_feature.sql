-- Insert payment_gateways feature if not exists
INSERT INTO public.features (key, display_name, description)
VALUES ('payment_gateways', 'Payment Gateways', 'Enable custom payment gateways like Paymob')
ON CONFLICT (key) DO NOTHING;

-- Link to all existing plans
INSERT INTO public.plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM public.plans p
CROSS JOIN public.features f
WHERE f.key = 'payment_gateways'
ON CONFLICT (plan_id, feature_id) DO NOTHING;

-- Create boolean limits for the plan features so it is enabled by default
INSERT INTO public.feature_limits (plan_feature_id, limit_type, limit_config)
SELECT pf.id, 'boolean', '{"enabled": true}'::jsonb
FROM public.plan_features pf
JOIN public.features f ON f.id = pf.feature_id
WHERE f.key = 'payment_gateways'
ON CONFLICT (plan_feature_id) DO UPDATE 
SET limit_config = '{"enabled": true}'::jsonb;
