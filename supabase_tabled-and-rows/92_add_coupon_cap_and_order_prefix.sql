-- 92_add_coupon_cap_and_order_prefix.sql
-- Add max_discount_cap to coupons for capping discount amounts
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS max_discount_cap numeric DEFAULT NULL;

-- Add order_prefix to site_settings for customizing store order/invoice prefixes
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS order_prefix text DEFAULT 'EG-';
