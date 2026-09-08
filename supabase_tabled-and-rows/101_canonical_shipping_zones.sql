-- Migration 101: Canonical Shipping Zones & Scopes
-- Adds canonical location identification, explicit scoping, priority, and fallback flags.

ALTER TABLE public.shipping_zones 
ADD COLUMN IF NOT EXISTS location_id TEXT,
ADD COLUMN IF NOT EXISTS scope_type TEXT DEFAULT 'CITY',
ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;

-- Index for tenant-scoped location lookup
CREATE INDEX IF NOT EXISTS idx_shipping_zones_store_loc 
ON public.shipping_zones (store_id, location_id, is_active);

-- Auto-backfill standard governorates if location_id is null
UPDATE public.shipping_zones SET location_id = 'EG-CAI', scope_type = 'GOVERNORATE' WHERE city_name = 'القاهرة' AND location_id IS NULL;
UPDATE public.shipping_zones SET location_id = 'EG-GZ', scope_type = 'GOVERNORATE' WHERE city_name = 'الجيزة' AND location_id IS NULL;
UPDATE public.shipping_zones SET location_id = 'EG-ALX', scope_type = 'GOVERNORATE' WHERE city_name = 'الإسكندرية' AND location_id IS NULL;
UPDATE public.shipping_zones SET location_id = 'EG-SHG', scope_type = 'GOVERNORATE' WHERE city_name = 'سوهاج' AND location_id IS NULL;
UPDATE public.shipping_zones SET location_id = 'EG-AST', scope_type = 'GOVERNORATE' WHERE city_name = 'أسيوط' AND location_id IS NULL;
UPDATE public.shipping_zones SET location_id = 'EG-KB', scope_type = 'GOVERNORATE' WHERE city_name = 'القليوبية' AND location_id IS NULL;
UPDATE public.shipping_zones SET is_fallback = true, scope_type = 'CUSTOM' WHERE city_name = 'محافظة أخرى';
