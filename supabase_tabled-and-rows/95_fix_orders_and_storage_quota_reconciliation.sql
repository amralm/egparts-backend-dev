-- Migration 95: Reconcile orders_per_month and lifetime storage_bytes feature usage
-- 1. Ensure all lifetime feature usage records start at epoch (1970-01-01 00:00:00+00)
UPDATE public.feature_usage 
SET period_start = to_timestamp(0) 
WHERE period = 'lifetime' AND period_start != to_timestamp(0);

-- 2. Populate orders_per_month for existing stores for the current month
INSERT INTO public.feature_usage (store_id, feature_key, period, period_start, period_end, usage_count)
SELECT 
  store_id, 
  'orders_per_month', 
  'monthly', 
  date_trunc('month', now()), 
  date_trunc('month', now()) + interval '1 month', 
  count(*)
FROM public.orders
WHERE created_at >= date_trunc('month', now())
GROUP BY store_id
ON CONFLICT (store_id, feature_key, period, period_start)
DO UPDATE SET usage_count = EXCLUDED.usage_count, updated_at = now();
