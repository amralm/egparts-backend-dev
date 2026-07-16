-- ============================================================
-- RLS Policies Fix — EG-PARTS
-- ============================================================
-- التشغيل: افتح Supabase SQL Editor و paste الكود ده

-- 1. ORDERS — تمكين RLS وإضافة السياسات
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_select_own" ON public.orders;
CREATE POLICY "user_select_own" ON public.orders
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_insert_own" ON public.orders;
CREATE POLICY "user_insert_own" ON public.orders
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_all_orders" ON public.orders;
CREATE POLICY "admin_all_orders" ON public.orders
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 2. COUPONS — تمكين RLS وإضافة السياسات
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_select_valid_coupons" ON public.coupons;
CREATE POLICY "public_select_valid_coupons" ON public.coupons
  FOR SELECT
  USING (
    is_active = true 
    AND (expiry_date IS NULL OR expiry_date > now())
  );

DROP POLICY IF EXISTS "admin_all_coupons" ON public.coupons;
CREATE POLICY "admin_all_coupons" ON public.coupons
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 3. BANNERS — إضافة سياسة للقراءة العامة
DROP POLICY IF EXISTS "public_select_active_banners" ON public.banners;
CREATE POLICY "public_select_active_banners" ON public.banners
  FOR SELECT
  USING (is_active = true);
