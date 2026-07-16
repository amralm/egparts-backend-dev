-- ============================================================
-- SQL Migration: Add Numeric Price to Products
-- ============================================================

-- 1. Add the new numeric column
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS price_numeric NUMERIC(12, 2);

-- 2. Migrate existing data from string to numeric
--    We replace commas and trim spaces before casting to prevent errors.
UPDATE public.products
SET price_numeric = CAST(REPLACE(COALESCE(price, '0'), ',', '') AS NUMERIC)
WHERE price_numeric IS NULL;

-- 3. (Optional but Recommended) Add indexes for fast Server-Side Searching & Pagination
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products (category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON public.products (brand);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON public.products (is_active);
CREATE INDEX IF NOT EXISTS idx_products_is_deleted ON public.products (is_deleted);
CREATE INDEX IF NOT EXISTS idx_products_price_numeric ON public.products (price_numeric);

-- Notes:
-- We are keeping the old `price` column as `price_display` string for presentation,
-- but the backend and filters will now rely exclusively on `price_numeric`.
