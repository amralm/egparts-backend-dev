-- ============================================================
-- RLS Policies Fix v2 — EG-PARTS
-- ============================================================
-- بيمسح كل السياسات القديمة (أيًا كان اسمها) وبعدين يضيف الجديدة

-- 1. ORDERS
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- امسح أي سياسات موجودة (بأي اسم)
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'orders' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.orders', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "user_select_own" ON public.orders
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_insert_own" ON public.orders
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin_all_orders" ON public.orders
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 2. COUPONS
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'coupons' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.coupons', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "public_select_valid_coupons" ON public.coupons
  FOR SELECT
  USING (is_active = true AND (expiry_date IS NULL OR expiry_date > now()));

CREATE POLICY "admin_all_coupons" ON public.coupons
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- أضف أعمدة التحكم في الضباب والتدرج (آمنة للتكرار)
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS overlay_opacity integer DEFAULT 40;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS blur_px integer DEFAULT 6;

-- 3. BANNERS (RLS مفعل بالفعل، فقط نضيف/نبدل السياسة)
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'banners' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.banners', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "public_select_active_banners" ON public.banners
  FOR SELECT
  USING (is_active = true);

CREATE POLICY "admin_all_banners" ON public.banners
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 4. ORDER ITEMS
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'order_items' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.order_items', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "user_select_own_items" ON public.order_items
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.orders WHERE id = order_id AND user_id = auth.uid()));

CREATE POLICY "user_insert_own_items" ON public.order_items
  FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.orders WHERE id = order_id AND user_id = auth.uid()));

CREATE POLICY "admin_all_order_items" ON public.order_items
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 5. منع تكرار رقم الموبايل (الثغرة الأمنية)
-- لو في صفوف مكررة، امسح الأحدث منها (احتفظ بالأقدم)
DELETE FROM public.user_profiles a USING (
  SELECT MIN(ctid) as ctid, phone FROM public.user_profiles
  WHERE phone IS NOT NULL
  GROUP BY phone HAVING count(*) > 1
) b WHERE a.phone = b.phone AND a.ctid <> b.ctid;
-- 6. USER_PROFILES — RLS policies (المستخدم يشوف ويعدل بياناته بس)
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'user_profiles' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_profiles', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "user_select_own_profile" ON public.user_profiles
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "user_update_own_profile" ON public.user_profiles
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "admin_all_profiles" ON public.user_profiles
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- ضيف القيد (آمنة للتكرار)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_profiles_phone_key'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_phone_key UNIQUE (phone);
  END IF;
END $$;

-- 7. سجل تسجيل الدخول
CREATE TABLE IF NOT EXISTS public.user_login_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  ip_address text,
  user_agent text,
  login_method text DEFAULT 'email',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_login_logs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'user_login_logs' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_login_logs', pol.policyname);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "admin_all_login_logs" ON public.user_login_logs;

CREATE POLICY "users_insert_login_logs" ON public.user_login_logs
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "admin_select_login_logs" ON public.user_login_logs
  FOR SELECT
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

CREATE POLICY "admin_delete_login_logs" ON public.user_login_logs
  FOR DELETE
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 8. USER_NOTIFICATIONS (admins insert/read all, users read own)
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'user_notifications' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_notifications', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "user_select_own_notifications" ON public.user_notifications
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "admin_all_notifications" ON public.user_notifications
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 9. ORDER_LOGS (admin insert/read only)
ALTER TABLE public.order_logs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'order_logs' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.order_logs', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "admin_all_order_logs" ON public.order_logs
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 11. BLOCKED_IPS (admin insert/read/delete only)
CREATE TABLE IF NOT EXISTS public.blocked_ips (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ip_address text NOT NULL UNIQUE,
  blocked_by uuid REFERENCES auth.users(id),
  reason text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.blocked_ips ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'blocked_ips' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.blocked_ips', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "admin_all_blocked_ips" ON public.blocked_ips
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- 10. NOTIFICATION_QUEUE (admin insert/read only)
ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'notification_queue' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.notification_queue', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "admin_all_notification_queue" ON public.notification_queue
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

-- Add content JSONB column for editable static text
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS content JSONB DEFAULT '{}'::jsonb;

-- 12. PRODUCTS RLS — needed for is_active toggle to work for admin
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE tablename = 'products' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.products', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "public_select_products" ON public.products
  FOR SELECT
  USING (true);

CREATE POLICY "admin_all_products" ON public.products
  FOR ALL
  USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')
  WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');
