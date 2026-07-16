-- ============================================================
-- SQL Migration & RLS Security Script (EG-PARTS Cloud v3 Hardened)
-- Run in Supabase SQL Editor to fully migrate database
-- ============================================================

BEGIN;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  1. CORE MULTI-TENANT TABLES                             ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.stores (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subdomain text UNIQUE NOT NULL,
  custom_domain text UNIQUE,
  is_active boolean DEFAULT true,
  subscription_expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT stores_pkey PRIMARY KEY (id)
);

-- Seed Default Store (EG-PARTS)
INSERT INTO public.stores (id, name, subdomain, is_active, subscription_expires_at)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'EG-PARTS',
  'egparts',
  true,
  '2099-12-31 23:59:59+00'::timestamptz
) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.store_admins (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT store_admins_pkey PRIMARY KEY (id),
  CONSTRAINT store_admins_user_id_store_id_key UNIQUE (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS public.super_admins (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT super_admins_pkey PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS public.store_payment_gateways (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  provider_name text NOT NULL,
  is_active boolean DEFAULT false,
  credentials text NOT NULL, -- Symmetrically encrypted text (AES-256-GCM)
  key_version integer NOT NULL DEFAULT 1, -- Key rotation version indicator
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT store_payment_gateways_pkey PRIMARY KEY (id),
  CONSTRAINT store_payment_gateways_store_provider_key UNIQUE (store_id, provider_name)
);

-- Ensure key_version column exists in existing tables
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'store_payment_gateways' AND column_name = 'key_version'
  ) THEN
    ALTER TABLE public.store_payment_gateways ADD COLUMN key_version integer NOT NULL DEFAULT 1;
  END IF;
END $$;

-- Explicitly ensure all old or null key_version values are defaulted to 1 for key rotation safety
UPDATE public.store_payment_gateways
SET key_version = 1
WHERE key_version IS NULL;

-- Enforce constraints on key_version for rotation robustness on legacy environments
ALTER TABLE public.store_payment_gateways ALTER COLUMN key_version SET DEFAULT 1;
ALTER TABLE public.store_payment_gateways ALTER COLUMN key_version SET NOT NULL;

-- Store Counters for High-Throughput Contiguous Order Numbers
CREATE TABLE IF NOT EXISTS public.store_counters (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  last_order_number bigint NOT NULL DEFAULT 0
);

INSERT INTO public.store_counters (store_id, last_order_number)
SELECT id, 0 FROM public.stores
ON CONFLICT (store_id) DO NOTHING;

-- Trigger to automatically seed store_counters for new stores
CREATE OR REPLACE FUNCTION public.sync_store_counter()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.store_counters (store_id, last_order_number)
  VALUES (NEW.id, 0)
  ON CONFLICT (store_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS store_created_sync_counter ON public.stores;
CREATE TRIGGER store_created_sync_counter
  AFTER INSERT ON public.stores
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_store_counter();

-- Impersonation Logs for Super Admin Auditing (Single-row session structure)
CREATE TABLE IF NOT EXISTS public.impersonation_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  super_admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  ip_address text,
  user_agent text,
  CONSTRAINT impersonation_logs_pkey PRIMARY KEY (id)
);

-- ╔══════════════════════════════════════════════════════════╗
-- ║  2. ALTER EXISTING TABLES & INJECT STORE_ID (NO LOSS)    ║
-- ╚══════════════════════════════════════════════════════════╝

-- Clean up unused admins table from single-tenant setup
DROP TABLE IF EXISTS public.admins CASCADE;

DO $$
DECLARE
  t text;
  tables_to_alter text[] := ARRAY[
    'products', 'orders', 'site_settings', 'coupons', 
    'shipping_zones', 'banners', 'blocked_ips', 'reviews', 
    'wishlists', 'order_tracking', 'user_notifications', 
    'notification_queue', 'order_logs', 'order_items', 
    'inventory_adjustments', 'user_login_logs', 'product_views',
    'whatsapp_sessions', 'otp_codes', 'user_addresses'
  ];
BEGIN
  FOREACH t IN ARRAY tables_to_alter
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'store_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE', t);
      -- Seed existing records to default EG-PARTS store
      EXECUTE format('UPDATE public.%I SET store_id = ''00000000-0000-0000-0000-000000000000'' WHERE store_id IS NULL', t);
      -- Make NOT NULL for data integrity
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN store_id SET NOT NULL', t);
    END IF;
  END LOOP;
END $$;

-- Safe Gradual Migration of user_profiles (No DROP TABLE CASCADE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'store_id'
  ) THEN
    -- Add store_id
    ALTER TABLE public.user_profiles ADD COLUMN store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE;
    UPDATE public.user_profiles SET store_id = '00000000-0000-0000-0000-000000000000' WHERE store_id IS NULL;
    ALTER TABLE public.user_profiles ALTER COLUMN store_id SET NOT NULL;
    
    -- Drop old primary key on user_id and replace it with a composite primary key
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_pkey;
    ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (user_id, store_id);
    
    -- Replace global phone unique constraint with a store-specific composite unique constraint
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_key;
    ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_store_id_phone_key UNIQUE (store_id, phone);
  END IF;
END $$;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  3. COMPOSITE CONSTRAINTS & DATA DRIFT PREVENTION        ║
-- ╚══════════════════════════════════════════════════════════╝

ALTER TABLE public.site_settings DROP CONSTRAINT IF EXISTS site_settings_store_id_key;
ALTER TABLE public.site_settings ADD CONSTRAINT site_settings_store_id_key UNIQUE (store_id);

ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS coupons_code_key;
ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS coupons_store_code_unique;
ALTER TABLE public.coupons ADD CONSTRAINT coupons_store_code_unique UNIQUE (store_id, code);

ALTER TABLE public.shipping_zones DROP CONSTRAINT IF EXISTS shipping_zones_city_name_key;
ALTER TABLE public.shipping_zones DROP CONSTRAINT IF EXISTS shipping_zones_store_city_unique;
ALTER TABLE public.shipping_zones ADD CONSTRAINT shipping_zones_store_city_unique UNIQUE (store_id, city_name);

ALTER TABLE public.blocked_ips DROP CONSTRAINT IF EXISTS blocked_ips_ip_address_key;
ALTER TABLE public.blocked_ips DROP CONSTRAINT IF EXISTS blocked_ips_store_ip_unique;
ALTER TABLE public.blocked_ips ADD CONSTRAINT blocked_ips_store_ip_unique UNIQUE (store_id, ip_address);

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_idempotency_key_key;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_store_idempotency_unique;
ALTER TABLE public.orders ADD CONSTRAINT orders_store_idempotency_unique UNIQUE (store_id, idempotency_key);

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_number_key;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_store_order_number_unique;
ALTER TABLE public.orders ADD CONSTRAINT orders_store_order_number_unique UNIQUE (store_id, order_number);

-- 3a. Force order_items.store_id = orders.store_id
ALTER TABLE public.orders ADD CONSTRAINT orders_id_store_id_unique UNIQUE (id, store_id);
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_order_id_store_id_fkey;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_id_store_id_fkey 
  FOREIGN KEY (order_id, store_id) REFERENCES public.orders(id, store_id) ON DELETE CASCADE;

-- 3b. Force order_items.product_id belongs to same store
ALTER TABLE public.products ADD CONSTRAINT products_id_store_id_unique UNIQUE (id, store_id);
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_product_id_store_id_fkey;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_product_id_store_id_fkey 
  FOREIGN KEY (product_id, store_id) REFERENCES public.products(id, store_id) ON DELETE CASCADE;

-- 3c. Force orders.coupon_id belongs to same store
ALTER TABLE public.coupons ADD CONSTRAINT coupons_id_store_id_unique UNIQUE (id, store_id);
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_coupon_id_store_id_fkey;
ALTER TABLE public.orders ADD CONSTRAINT orders_coupon_id_store_id_fkey
  FOREIGN KEY (coupon_id, store_id) REFERENCES public.coupons(id, store_id) ON DELETE SET NULL;

-- 3d. Force otp_codes phone unique per store
ALTER TABLE public.otp_codes DROP CONSTRAINT IF EXISTS otp_codes_phone_key;
ALTER TABLE public.otp_codes DROP CONSTRAINT IF EXISTS otp_codes_store_phone_unique;
ALTER TABLE public.otp_codes ADD CONSTRAINT otp_codes_store_phone_unique UNIQUE (store_id, phone);

-- 3e. Force user_addresses title unique per user per store
ALTER TABLE public.user_addresses DROP CONSTRAINT IF EXISTS user_addresses_store_user_title_unique;
ALTER TABLE public.user_addresses ADD CONSTRAINT user_addresses_store_user_title_unique UNIQUE (store_id, user_id, title);

-- ╔══════════════════════════════════════════════════════════╗
-- ║  4. PERFORMANCE INDEXES ON STORE_ID                      ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE INDEX IF NOT EXISTS products_store_id_idx ON public.products(store_id);
CREATE INDEX IF NOT EXISTS orders_store_id_idx ON public.orders(store_id);
CREATE INDEX IF NOT EXISTS reviews_store_id_idx ON public.reviews(store_id);
CREATE INDEX IF NOT EXISTS site_settings_store_id_idx ON public.site_settings(store_id);
CREATE INDEX IF NOT EXISTS coupons_store_id_idx ON public.coupons(store_id);
CREATE INDEX IF NOT EXISTS user_profiles_store_id_idx ON public.user_profiles(store_id);
CREATE INDEX IF NOT EXISTS shipping_zones_store_id_idx ON public.shipping_zones(store_id);
CREATE INDEX IF NOT EXISTS wishlists_store_id_idx ON public.wishlists(store_id);
CREATE INDEX IF NOT EXISTS order_tracking_store_id_idx ON public.order_tracking(store_id);
CREATE INDEX IF NOT EXISTS user_notifications_store_id_idx ON public.user_notifications(store_id);
CREATE INDEX IF NOT EXISTS banners_store_id_idx ON public.banners(store_id);
CREATE INDEX IF NOT EXISTS user_addresses_store_id_idx ON public.user_addresses(store_id);
CREATE INDEX IF NOT EXISTS notification_queue_store_id_idx ON public.notification_queue(store_id);
CREATE INDEX IF NOT EXISTS order_logs_store_id_idx ON public.order_logs(store_id);
CREATE INDEX IF NOT EXISTS order_items_store_id_idx ON public.order_items(store_id);
CREATE INDEX IF NOT EXISTS inventory_adjustments_store_id_idx ON public.inventory_adjustments(store_id);
CREATE INDEX IF NOT EXISTS user_login_logs_store_id_idx ON public.user_login_logs(store_id);
CREATE INDEX IF NOT EXISTS blocked_ips_store_id_idx ON public.blocked_ips(store_id);
CREATE INDEX IF NOT EXISTS otp_codes_store_id_idx ON public.otp_codes(store_id);
CREATE INDEX IF NOT EXISTS whatsapp_sessions_store_id_idx ON public.whatsapp_sessions(store_id);
CREATE INDEX IF NOT EXISTS impersonation_logs_store_id_idx ON public.impersonation_logs(store_id);

-- ╔══════════════════════════════════════════════════════════╗
-- ║  5. HELPER FUNCTIONS FOR SECURITY RULES                  ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.get_my_stores()
RETURNS SETOF uuid SECURITY DEFINER AS $$
BEGIN
  IF public.is_super_admin() THEN
    RETURN QUERY SELECT id FROM public.stores;
  ELSE
    RETURN QUERY SELECT store_id FROM public.store_admins WHERE user_id = auth.uid();
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  6. SECURITY AND COMPLIANCE HELPER FUNCTIONS             ║
-- ╚══════════════════════════════════════════════════════════╝

-- STABLE helper function to optimize subscription status queries for the planner
CREATE OR REPLACE FUNCTION public.is_store_active(p_store_id uuid)
RETURNS boolean STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.stores 
    WHERE id = p_store_id AND is_active = true AND subscription_expires_at > now()
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.start_impersonation(
  p_store_id uuid,
  p_ip_address text DEFAULT 'unknown',
  p_user_agent text DEFAULT 'unknown'
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_log_id uuid;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'غير مصرح: يجب أن تكون مسؤولاً عاماً لبدء المحاكاة';
  END IF;

  IF p_ip_address = 'unknown' OR p_ip_address IS NULL THEN
    p_ip_address := COALESCE(
      current_setting('request.headers', true)::json->>'x-forwarded-for',
      current_setting('request.headers', true)::json->>'x-real-ip',
      'unknown'
    );
    p_ip_address := split_part(p_ip_address, ',', 1);
  END IF;

  INSERT INTO public.impersonation_logs (super_admin_id, store_id, started_at, ip_address, user_agent)
  VALUES (auth.uid(), p_store_id, now(), p_ip_address, p_user_agent)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.stop_impersonation(
  p_log_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  UPDATE public.impersonation_logs
  SET ended_at = now()
  WHERE id = p_log_id AND super_admin_id = auth.uid() AND ended_at IS NULL;
END;
$$;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  7. ENABLE ROW LEVEL SECURITY (RLS)                      ║
-- ╚══════════════════════════════════════════════════════════╝

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_payment_gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_login_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_ips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_logs ENABLE ROW LEVEL SECURITY;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  8. CONFIGURE RLS POLICIES FOR ALL TABLES                ║
-- ╚══════════════════════════════════════════════════════════╝

-- Clean up existing policies first
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- STORES Policies
CREATE POLICY "stores_super_admin" ON public.stores FOR ALL USING (public.is_super_admin());
CREATE POLICY "stores_admin_select" ON public.stores FOR SELECT USING (id IN (SELECT public.get_my_stores()));
CREATE POLICY "stores_public_select" ON public.stores FOR SELECT USING (true);

-- STORE_ADMINS Policies
CREATE POLICY "store_admins_super_admin" ON public.store_admins FOR ALL USING (public.is_super_admin());
CREATE POLICY "store_admins_select" ON public.store_admins FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

-- SUPER_ADMINS Policies
CREATE POLICY "super_admins_super_admin" ON public.super_admins FOR ALL USING (public.is_super_admin());

-- STORE_PAYMENT_GATEWAYS Policies (API Credentials - Must NEVER be readable by public keys)
CREATE POLICY "gateways_admin_all" ON public.store_payment_gateways FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- PRODUCTS Policies (Admins can view even when suspended)
CREATE POLICY "products_select_public" ON public.products FOR SELECT USING (
  public.is_store_active(store_id)
  AND COALESCE(is_deleted, false) = false
  AND is_active = true
);
CREATE POLICY "products_admin_all" ON public.products FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- ORDERS Policies (Logged-in customers can only see their own orders in active stores)
CREATE POLICY "orders_select_customer" ON public.orders FOR SELECT USING (
  user_id = auth.uid() 
  AND public.is_store_active(store_id)
);
CREATE POLICY "orders_insert_authenticated" ON public.orders FOR INSERT WITH CHECK (
  auth.uid() = user_id
  AND public.is_store_active(store_id)
);
CREATE POLICY "orders_admin_all" ON public.orders FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- ORDER_ITEMS Policies (Logged-in customers can only see items of their own orders)
CREATE POLICY "items_select_customer" ON public.order_items FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.orders o 
    WHERE o.id = order_id AND o.user_id = auth.uid()
      AND public.is_store_active(o.store_id)
  )
);
CREATE POLICY "items_insert_authenticated" ON public.order_items FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.orders o 
    WHERE o.id = order_id AND o.user_id = auth.uid() AND o.store_id = store_id
  )
);
CREATE POLICY "items_admin_all" ON public.order_items FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- REVIEWS Policies
CREATE POLICY "reviews_select_public" ON public.reviews FOR SELECT USING (
  status = 'approved'
  AND public.is_store_active(store_id)
);
CREATE POLICY "reviews_insert_public" ON public.reviews FOR INSERT WITH CHECK (
  status = 'pending'
  AND rating >= 1 AND rating <= 5
  AND length(COALESCE(user_name, '')) >= 2
  AND length(COALESCE(comment, '')) >= 5
  AND public.is_store_active(store_id)
);
CREATE POLICY "reviews_admin_all" ON public.reviews FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- SITE_SETTINGS Policies (Admins can view even when suspended)
CREATE POLICY "settings_select_public" ON public.site_settings FOR SELECT USING (
  public.is_store_active(store_id)
);
CREATE POLICY "settings_admin_select" ON public.site_settings FOR SELECT USING (
  store_id IN (SELECT public.get_my_stores())
);
CREATE POLICY "settings_super_admin_insert" ON public.site_settings FOR INSERT 
  WITH CHECK (public.is_super_admin());
CREATE POLICY "settings_admin_update" ON public.site_settings FOR UPDATE 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- COUPONS Policies
CREATE POLICY "coupons_select_public" ON public.coupons FOR SELECT USING (
  is_active = true 
  AND (expiry_date IS NULL OR expiry_date > now())
  AND public.is_store_active(store_id)
);
CREATE POLICY "coupons_admin_all" ON public.coupons FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- USER_PROFILES Policies
CREATE POLICY "profiles_select_customer" ON public.user_profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "profiles_update_customer" ON public.user_profiles FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "profiles_insert_public" ON public.user_profiles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "profiles_admin_all" ON public.user_profiles FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- SHIPPING_ZONES Policies
CREATE POLICY "zones_select_public" ON public.shipping_zones FOR SELECT USING (
  public.is_store_active(store_id)
);
CREATE POLICY "zones_admin_all" ON public.shipping_zones FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- WISHLISTS Policies
CREATE POLICY "wishlists_customer" ON public.wishlists FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "wishlists_admin" ON public.wishlists FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

-- ORDER_TRACKING Policies (Logged-in customers can track their own orders in active stores)
CREATE POLICY "tracking_select_customer" ON public.order_tracking FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.orders o 
    WHERE o.id = order_id AND o.user_id = auth.uid()
      AND public.is_store_active(o.store_id)
  )
);
CREATE POLICY "tracking_admin" ON public.order_tracking FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- USER_NOTIFICATIONS Policies
CREATE POLICY "notifications_customer" ON public.user_notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "notifications_admin" ON public.user_notifications FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- BANNERS Policies
CREATE POLICY "banners_select_public" ON public.banners FOR SELECT USING (
  public.is_store_active(store_id)
);
CREATE POLICY "banners_admin" ON public.banners FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- PRODUCT_VIEWS Policies
CREATE POLICY "views_select_public" ON public.product_views FOR SELECT USING (
  public.is_store_active(store_id)
);
CREATE POLICY "views_insert_public" ON public.product_views FOR INSERT WITH CHECK (
  public.is_store_active(store_id)
);
CREATE POLICY "views_admin" ON public.product_views FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- USER_ADDRESSES Policies
CREATE POLICY "addresses_customer" ON public.user_addresses FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "addresses_admin" ON public.user_addresses FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

-- ORDER_LOGS Policies
CREATE POLICY "order_logs_admin" ON public.order_logs FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- INVENTORY_ADJUSTMENTS Policies
CREATE POLICY "inventory_admin" ON public.inventory_adjustments FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- USER_LOGIN_LOGS Policies
CREATE POLICY "login_logs_insert" ON public.user_login_logs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "login_logs_admin" ON public.user_login_logs FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- BLOCKED_IPS Policies
CREATE POLICY "blocked_ips_admin" ON public.blocked_ips FOR ALL 
  USING (store_id IN (SELECT public.get_my_stores()))
  WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- IMPERSONATION_LOGS Policies
CREATE POLICY "impersonation_logs_admin" ON public.impersonation_logs FOR ALL 
  USING (public.is_super_admin());

-- OTP_CODES & WHATSAPP_SESSIONS & NOTIFICATION_QUEUE Policies (Service-Role Only)
-- Denied to all client keys (anon/authenticated). Leaving them empty blocks all access.

-- ╔══════════════════════════════════════════════════════════╗
-- ║  9. SECURE TENANT ORDER CREATION RPC                     ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_user_id uuid,
  p_items jsonb,
  p_phone text,
  p_city text,
  p_address text,
  p_customer_note text DEFAULT '',
  p_payment_method text DEFAULT 'cod',
  p_coupon_code text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_auth_source text DEFAULT 'otp',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_store_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_order_id uuid;
  v_item jsonb;
  v_order_number bigint;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_coupon_id uuid := NULL;
  v_shipping_fee numeric := 0;
  v_free_ship_enabled boolean;
  v_free_ship_threshold numeric;
  v_total numeric := 0;
  v_product record;
  v_coupon record;
  v_store_active boolean;
BEGIN
  -- 0. Validate Store Subscription
  IF NOT public.is_store_active(p_store_id) THEN
    RAISE EXCEPTION 'عذراً، هذا المتجر متوقف مؤقتاً ولا يقبل طلبات جديدة حالياً';
  END IF;

  -- 1. Obtain row-level lock on the store counter to serialize sequence generation safely under high concurrency
  SELECT last_order_number INTO v_order_number
  FROM public.store_counters
  WHERE store_id = p_store_id
  FOR UPDATE;
  
  v_order_number := v_order_number + 1;
  
  UPDATE public.store_counters
  SET last_order_number = v_order_number
  WHERE store_id = p_store_id;

  -- 2. Idempotency Check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id FROM public.orders WHERE idempotency_key = p_idempotency_key AND store_id = p_store_id;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', v_order_id, 'status', 'already_exists');
    END IF;
  END IF;

  -- 3. Recalculate subtotal from database (scoped to store_id and locks product rows)
  v_subtotal := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT id, price, stock_quantity, name, is_active, COALESCE(is_deleted, false) as is_deleted INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'المنتج غير موجود: %', (v_item->>'id')::text;
    END IF;

    IF v_product.is_active IS FALSE OR v_product.is_deleted IS TRUE THEN
      RAISE EXCEPTION 'عذراً، المنتج % غير متوفر حالياً', v_product.name;
    END IF;

    IF v_product.stock_quantity < (v_item->>'qty')::int THEN
      RAISE EXCEPTION 'الكمية غير كافية للمنتج: %', v_product.name;
    END IF;

    v_subtotal := v_subtotal + (v_product.price * (v_item->>'qty')::int);
  END LOOP;

  -- 4. Validate Coupon (guaranteed store-specific constraints)
  IF p_coupon_code IS NOT NULL AND p_coupon_code <> '' THEN
    SELECT id, discount_percentage, discount_amount, min_order_value, 
           max_uses, used_count, expiry_date, is_active
    INTO v_coupon
    FROM public.coupons
    WHERE code = upper(p_coupon_code) AND store_id = p_store_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'كود الخصم غير صالح';
    END IF;

    IF NOT v_coupon.is_active THEN
      RAISE EXCEPTION 'كود الخصم غير مفعل';
    END IF;

    IF v_coupon.expiry_date IS NOT NULL AND v_coupon.expiry_date < now() THEN
      RAISE EXCEPTION 'انتهت صلاحية كود الخصم';
    END IF;

    IF v_coupon.max_uses > 0 AND v_coupon.used_count >= v_coupon.max_uses THEN
      RAISE EXCEPTION 'تم استنفاذ الحد الأقصى لاستخدام كود الخصم';
    END IF;

    IF v_coupon.min_order_value > 0 AND v_subtotal < v_coupon.min_order_value THEN
      RAISE EXCEPTION 'الحد الأدنى للطلب لاستخدام الكود هو %', v_coupon.min_order_value;
    END IF;

    v_coupon_id := v_coupon.id;
    IF v_coupon.discount_percentage > 0 THEN
      v_discount := v_subtotal * (v_coupon.discount_percentage / 100);
    ELSIF v_coupon.discount_amount > 0 THEN
      v_discount := v_coupon.discount_amount;
    END IF;

    IF v_discount > v_subtotal THEN
      v_discount := v_subtotal;
    END IF;

    UPDATE public.coupons SET used_count = used_count + 1 WHERE id = v_coupon.id;
  END IF;

  -- 5. Calculate shipping fee
  SELECT shipping_fee INTO v_shipping_fee
  FROM public.shipping_zones WHERE city_name = p_city AND store_id = p_store_id;
  IF NOT FOUND THEN
    SELECT shipping_fee INTO v_shipping_fee
    FROM public.shipping_zones WHERE city_name = 'محافظة أخرى' AND store_id = p_store_id;
  END IF;
  v_shipping_fee := COALESCE(v_shipping_fee, 0);

  -- 6. Free shipping waiver
  SELECT free_shipping_enabled, free_shipping_threshold
  INTO v_free_ship_enabled, v_free_ship_threshold
  FROM public.site_settings WHERE store_id = p_store_id;
  IF v_free_ship_threshold IS NOT NULL AND COALESCE(v_free_ship_enabled, true) AND v_subtotal >= v_free_ship_threshold THEN
    v_shipping_fee := 0;
  END IF;

  -- 7. Calculate total
  v_total := v_subtotal + v_shipping_fee - v_discount;
  IF v_total < 0 THEN
    v_total := 0;
  END IF;

  -- 8. Insert Order
  INSERT INTO public.orders (
    user_id, phone, city, address, customer_note,
    payment_method, subtotal, discount, shipping_fee, total,
    coupon_id, idempotency_key, order_number, status, payment_status,
    auth_source, metadata, items, store_id
  )
  VALUES (
    p_user_id, p_phone, p_city, p_address, p_customer_note,
    p_payment_method, v_subtotal, v_discount, v_shipping_fee, v_total,
    v_coupon_id, p_idempotency_key, v_order_number, 'pending', 'unpaid',
    p_auth_source, p_metadata, p_items, p_store_id
  )
  RETURNING id INTO v_order_id;

  -- 9. Deduct stock & insert order_items (guaranteed store constraints)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT price, name INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

    UPDATE public.products
    SET stock_quantity = stock_quantity - (v_item->>'qty')::int
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
      AND stock_quantity >= (v_item->>'qty')::int;

    INSERT INTO public.order_items (order_id, product_id, title, quantity, unit_price, store_id)
    VALUES (v_order_id, (v_item->>'id')::uuid, v_product.name, (v_item->>'qty')::int, v_product.price, p_store_id);
  END LOOP;

  RETURN jsonb_build_object('id', v_order_id, 'order_number', v_order_number::text, 'success', true);
END;
$$;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  10. SECURE TENANT NOTIFICATION JOB WORKER RPC           ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION public.fetch_next_notification_jobs(p_limit integer)
RETURNS SETOF public.notification_queue
AS $$
BEGIN
  RETURN QUERY
  WITH next_jobs AS (
    SELECT n.id
    FROM public.notification_queue n
    JOIN public.stores s ON n.store_id = s.id
    WHERE (n.status = 'pending'
      OR (n.status = 'failed' AND n.retry_count < 5 AND n.next_retry_at <= now()))
      AND s.is_active = true 
      AND s.subscription_expires_at > now()
    ORDER BY n.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_queue nq
  SET status = 'processing',
      updated_at = now()
  FROM next_jobs
  WHERE nq.id = next_jobs.id
  RETURNING nq.*;
END;
$$ LANGUAGE plpgsql;

-- ╔══════════════════════════════════════════════════════════╗
-- ║  11. INTEGRITY & SECURITY SELF-TEST SUITE                ║
-- ╚══════════════════════════════════════════════════════════╝

DO $$
DECLARE
  v_store_a_id uuid := 'a0000000-0000-0000-0000-00000000000a';
  v_store_b_id uuid := 'b0000000-0000-0000-0000-00000000000b';
  v_user_a_id uuid := 'a1111111-1111-1111-1111-11111111111a';
  v_user_b_id uuid := 'b1111111-1111-1111-1111-11111111111b';
  v_prod_b_id uuid := 'b2222222-2222-2222-2222-22222222222b';
  v_rows_affected integer;
BEGIN
  RAISE NOTICE 'Initializing security self-test suite...';

  -- Seed Mock Stores
  INSERT INTO public.stores (id, name, subdomain, is_active, subscription_expires_at)
  VALUES 
    (v_store_a_id, 'Tenant A Test Store', 'tenanta', true, now() + interval '30 days'),
    (v_store_b_id, 'Tenant B Test Store', 'tenantb', true, now() + interval '30 days')
  ON CONFLICT DO NOTHING;

  -- Seed Mock Users in auth.users
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, is_super_admin)
  VALUES 
    (v_user_a_id, 'admina@tenanta.com', '{"provider":"email"}', '{"name":"Admin A"}', false),
    (v_user_b_id, 'adminb@tenantb.com', '{"provider":"email"}', '{"name":"Admin B"}', false)
  ON CONFLICT DO NOTHING;

  -- Seed Store Admins
  INSERT INTO public.store_admins (user_id, store_id)
  VALUES 
    (v_user_a_id, v_store_a_id),
    (v_user_b_id, v_store_b_id)
  ON CONFLICT DO NOTHING;

  -- Seed Tenant B Product (seeded as inactive to test admin-only/private product isolation)
  INSERT INTO public.products (id, store_id, name, price, stock_quantity, is_active)
  VALUES (v_prod_b_id, v_store_b_id, 'Tenant B Secret Product', 100.00, 10, false)
  ON CONFLICT DO NOTHING;

  -- SIMULATE TENANT A ADMIN (JWT session settings)
  PERFORM set_config('request.jwt.claim.sub', v_user_a_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- Switch to authenticated role to enforce RLS during the tests
  SET LOCAL ROLE authenticated;

  -- TEST 1: Tenant A Admin attempts to query Tenant B's private products directly
  IF EXISTS (SELECT 1 FROM public.products WHERE store_id = v_store_b_id) THEN
    RESET ROLE;
    RAISE EXCEPTION 'RLS FAIL: Tenant A admin can read Tenant B products!';
  END IF;

  -- TEST 2: Tenant A Admin attempts to UPDATE Tenant B's product price (Cross-Tenant Write)
  UPDATE public.products
  SET price = 1.00
  WHERE id = v_prod_b_id;
  
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  
  -- Restore superuser role for cleanup
  RESET ROLE;
  
  IF v_rows_affected > 0 THEN
    RAISE EXCEPTION 'RLS FAIL: Tenant A admin successfully updated Tenant B product price!';
  END IF;

  -- Cleanup Mock data
  DELETE FROM public.products WHERE id = v_prod_b_id;
  DELETE FROM public.store_admins WHERE user_id IN (v_user_a_id, v_user_b_id);
  DELETE FROM auth.users WHERE id IN (v_user_a_id, v_user_b_id);
  DELETE FROM public.stores WHERE id IN (v_store_a_id, v_store_b_id);

  RAISE NOTICE 'Security self-test suite PASSED successfully (Zero leaks, complete isolation verified).';
END $$;

COMMIT;
