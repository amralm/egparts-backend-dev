-- Migration 30: Expand order and product limits to generous realistic tiers and enforce soft limit policy
-- Free: 50 orders/mo, 100 total orders, 30 products
-- Basic: 300 orders/mo, 600 total orders, 250 products
-- Starter: 1,500 orders/mo, 3,000 total orders, 1,000 products
-- Growth: 6,000 orders/mo, 12,000 total orders, 5,000 products
-- Scale: 25,000 orders/mo, 50,000 total orders, 20,000 products
-- Enterprise: -1 (unlimited)

DO $$
BEGIN
  -- 1. Free Plan Limits
  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 50), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'free' AND f.key = 'orders_per_month';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 100), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'free' AND f.key = 'orders';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 30), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'free' AND f.key = 'products';

  -- 2. Basic Plan Limits
  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 300), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'basic' AND f.key = 'orders_per_month';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 600), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'basic' AND f.key = 'orders';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 250), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'basic' AND f.key = 'products';

  -- 3. Starter Plan Limits
  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 1500), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'starter' AND f.key = 'orders_per_month';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 3000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'starter' AND f.key = 'orders';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 1000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'starter' AND f.key = 'products';

  -- 4. Growth Plan Limits
  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 6000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'growth' AND f.key = 'orders_per_month';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 12000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'growth' AND f.key = 'orders';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 5000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'growth' AND f.key = 'products';

  -- 5. Scale Plan Limits
  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 25000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'scale' AND f.key = 'orders_per_month';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 50000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'scale' AND f.key = 'orders';

  UPDATE public.feature_limits fl
  SET limit_config = jsonb_build_object('max_value', 20000), limit_type = 'count'
  FROM public.plan_features pf
  JOIN public.plans p ON p.id = pf.plan_id
  JOIN public.features f ON f.id = pf.feature_id
  WHERE fl.plan_feature_id = pf.id AND p.code = 'scale' AND f.key = 'products';

END $$;
