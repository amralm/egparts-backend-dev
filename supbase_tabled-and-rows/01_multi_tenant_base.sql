-- ============================================================
-- SQL Migration: Multi-Tenant Architecture (EG-PARTS Cloud)
-- Run in Supabase SQL Editor to migrate database to Multi-Tenant
-- ============================================================

-- 1. Create Stores Table
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

-- Seed Default Store (EG-PARTS) for backward compatibility
INSERT INTO public.stores (id, name, subdomain, is_active, subscription_expires_at)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'EG-PARTS',
  'egparts',
  true,
  '2099-12-31 23:59:59+00'::timestamptz
) ON CONFLICT (id) DO NOTHING;

-- 2. Create Store Admins Mapping Table
CREATE TABLE IF NOT EXISTS public.store_admins (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT store_admins_pkey PRIMARY KEY (id),
  CONSTRAINT store_admins_user_id_store_id_key UNIQUE (user_id, store_id)
);

-- 3. Create Super Admins Table
CREATE TABLE IF NOT EXISTS public.super_admins (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT super_admins_pkey PRIMARY KEY (user_id)
);

-- 4. Create Store Payment Gateways Configuration Table
CREATE TABLE IF NOT EXISTS public.store_payment_gateways (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  provider_name text NOT NULL, -- 'paymob', 'fawry', etc.
  is_active boolean DEFAULT false,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT store_payment_gateways_pkey PRIMARY KEY (id),
  CONSTRAINT store_payment_gateways_store_provider_key UNIQUE (store_id, provider_name)
);

-- 5. Add store_id to existing tables and default to EG-PARTS
DO $$
DECLARE
  t text;
  tables_to_alter text[] := ARRAY[
    'products', 'orders', 'site_settings', 'coupons', 
    'shipping_zones', 'banners', 'blocked_ips', 'reviews', 
    'wishlists', 'user_notifications', 'notification_queue'
  ];
BEGIN
  FOREACH t IN ARRAY tables_to_alter
  LOOP
    -- Check if column exists, if not add it
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'store_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE', t);
      -- Assign existing records to default EG-PARTS store
      EXECUTE format('UPDATE public.%I SET store_id = ''00000000-0000-0000-0000-000000000000'' WHERE store_id IS NULL', t);
      -- Make store_id NOT NULL for data integrity
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN store_id SET NOT NULL', t);
    END IF;
  END LOOP;
END $$;

-- 6. Redefine user_profiles to allow store-isolated profiles
-- Step 6a: Rename/Backup old user_profiles if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'store_id'
  ) THEN
    -- Backup old profiles data to temporary table
    CREATE TEMP TABLE temp_user_profiles AS SELECT * FROM public.user_profiles;
    DROP TABLE public.user_profiles CASCADE;
    
    -- Recreate user_profiles with store_id support
    CREATE TABLE public.user_profiles (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
      full_name text,
      phone text,
      city text,
      address text,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now(),
      is_banned boolean DEFAULT false,
      ban_reason text,
      last_active timestamp with time zone DEFAULT now(),
      notes text,
      email text,
      CONSTRAINT user_profiles_pkey PRIMARY KEY (id),
      CONSTRAINT user_profiles_user_id_store_id_key UNIQUE (user_id, store_id)
    );

    -- Restore old profiles mapped to default store
    INSERT INTO public.user_profiles (user_id, store_id, full_name, phone, city, address, created_at, updated_at, is_banned, ban_reason, last_active, notes, email)
    SELECT user_id, '00000000-0000-0000-0000-000000000000', full_name, phone, city, address, created_at, updated_at, is_banned, ban_reason, last_active, notes, email
    FROM temp_user_profiles;
    
    DROP TABLE temp_user_profiles;
  END IF;
END $$;

-- 7. Unique site_settings per store_id constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'site_settings_store_id_key' AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE public.site_settings ADD CONSTRAINT site_settings_store_id_key UNIQUE (store_id);
  END IF;
END $$;

-- 8. Core SQL Helper Functions
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.get_my_stores()
RETURNS TABLE(store_id uuid) SECURITY DEFINER AS $$
BEGIN
  IF public.is_super_admin() THEN
    RETURN QUERY SELECT id FROM public.stores;
  ELSE
    RETURN QUERY SELECT s.store_id FROM public.store_admins s WHERE s.user_id = auth.uid();
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 9. Setup Row Level Security (RLS) policies for Multi-Tenancy
-- We will apply store_id scopes for admins and active store scopes for the public.

-- Helper: Enable RLS on all altered tables
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_payment_gateways ENABLE ROW LEVEL SECURITY;

-- STORES Policies
CREATE POLICY "super_admins_all_stores" ON public.stores FOR ALL USING (public.is_super_admin());
CREATE POLICY "store_admins_select_own_stores" ON public.stores FOR SELECT USING (id IN (SELECT public.get_my_stores()));
CREATE POLICY "public_select_active_stores" ON public.stores FOR SELECT USING (is_active = true AND subscription_expires_at > now());

-- STORE_ADMINS Policies
CREATE POLICY "super_admins_all_store_admins" ON public.store_admins FOR ALL USING (public.is_super_admin());
CREATE POLICY "store_admins_select_own_mappings" ON public.store_admins FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

-- PRODUCTS Policies
DROP POLICY IF EXISTS "products_select_public" ON public.products;
DROP POLICY IF EXISTS "products_all_admin" ON public.products;

CREATE POLICY "products_select_public" ON public.products FOR SELECT 
USING (
  store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now())
  AND COALESCE(is_deleted, false) = false
  AND is_active = true
);

CREATE POLICY "products_all_admin" ON public.products FOR ALL 
USING (store_id IN (SELECT public.get_my_stores())) 
WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- ORDERS Policies
DROP POLICY IF EXISTS "orders_select_admin" ON public.orders;
DROP POLICY IF EXISTS "orders_all_admin" ON public.orders;
DROP POLICY IF EXISTS "guest_select_own_order" ON public.orders;

CREATE POLICY "orders_all_admin" ON public.orders FOR ALL 
USING (store_id IN (SELECT public.get_my_stores()))
WITH CHECK (store_id IN (SELECT public.get_my_stores()));

CREATE POLICY "orders_insert_public" ON public.orders FOR INSERT 
WITH CHECK (store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now()));

CREATE POLICY "orders_select_customer" ON public.orders FOR SELECT 
USING (
  user_id = auth.uid() 
  OR (user_id IS NULL AND auth.uid() IS NULL) -- Allow guest tracking via unguessable UUID filter in client query
);

-- SITE_SETTINGS Policies
DROP POLICY IF EXISTS "settings_select_public" ON public.site_settings;
DROP POLICY IF EXISTS "settings_update_admin" ON public.site_settings;

CREATE POLICY "settings_select_public" ON public.site_settings FOR SELECT 
USING (store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now()));

CREATE POLICY "settings_update_admin" ON public.site_settings FOR UPDATE 
USING (store_id IN (SELECT public.get_my_stores()))
WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- REVIEWS Policies
DROP POLICY IF EXISTS "reviews_select_approved" ON public.reviews;
DROP POLICY IF EXISTS "reviews_select_admin" ON public.reviews;
DROP POLICY IF EXISTS "reviews_insert_public" ON public.reviews;
DROP POLICY IF EXISTS "reviews_update_admin" ON public.reviews;
DROP POLICY IF EXISTS "reviews_delete_admin" ON public.reviews;

CREATE POLICY "reviews_select_approved" ON public.reviews FOR SELECT 
USING (
  status = 'approved' 
  AND store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now())
);

CREATE POLICY "reviews_select_admin" ON public.reviews FOR SELECT 
USING (store_id IN (SELECT public.get_my_stores()));

CREATE POLICY "reviews_insert_public" ON public.reviews FOR INSERT 
WITH CHECK (
  status = 'pending'
  AND rating >= 1 AND rating <= 5
  AND length(COALESCE(user_name, '')) >= 2
  AND length(COALESCE(comment, '')) >= 5
  AND store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now())
);

CREATE POLICY "reviews_all_admin" ON public.reviews FOR ALL 
USING (store_id IN (SELECT public.get_my_stores()))
WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- BANNERS Policies
CREATE POLICY "banners_select_public" ON public.banners FOR SELECT 
USING (store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now()));

CREATE POLICY "banners_all_admin" ON public.banners FOR ALL 
USING (store_id IN (SELECT public.get_my_stores()))
WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- COUPONS Policies
DROP POLICY IF EXISTS "coupons_select_admin_only" ON public.coupons;
DROP POLICY IF EXISTS "coupons_all_admin" ON public.coupons;

CREATE POLICY "coupons_select_public" ON public.coupons FOR SELECT 
USING (
  is_active = true 
  AND store_id IN (SELECT id FROM public.stores WHERE is_active = true AND subscription_expires_at > now())
);

CREATE POLICY "coupons_all_admin" ON public.coupons FOR ALL 
USING (store_id IN (SELECT public.get_my_stores()))
WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- USER_PROFILES Policies
DROP POLICY IF EXISTS "user_profiles_select" ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_update" ON public.user_profiles;

CREATE POLICY "profiles_select_customer" ON public.user_profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "profiles_select_admin" ON public.user_profiles FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY "profiles_insert_public" ON public.user_profiles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "profiles_update_customer" ON public.user_profiles FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "profiles_update_admin" ON public.user_profiles FOR UPDATE USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- 10. Update create_order_atomic to support p_store_id
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
  SELECT is_active AND (subscription_expires_at > now()) INTO v_store_active
  FROM public.stores WHERE id = p_store_id;
  IF NOT COALESCE(v_store_active, false) THEN
    RAISE EXCEPTION 'عذراً، هذا المتجر متوقف مؤقتاً ولا يقبل طلبات جديدة حالياً';
  END IF;

  -- 1. Idempotency Check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id FROM public.orders WHERE idempotency_key = p_idempotency_key;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', v_order_id, 'status', 'already_exists');
    END IF;
  END IF;

  -- 2. Recalculate subtotal FROM database (scoped to store_id)
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

  -- 3. Validate coupon if provided
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

  -- 4. Generate order number
  SELECT nextval('order_number_seq') INTO v_order_number;

  -- 5. Calculate shipping fee based on city
  SELECT shipping_fee INTO v_shipping_fee
  FROM public.shipping_zones WHERE city_name = p_city AND store_id = p_store_id;
  IF NOT FOUND THEN
    SELECT shipping_fee INTO v_shipping_fee
    FROM public.shipping_zones WHERE city_name = 'محافظة أخرى' AND store_id = p_store_id;
  END IF;
  v_shipping_fee := COALESCE(v_shipping_fee, 0);

  -- 5b. Free shipping
  SELECT free_shipping_enabled, free_shipping_threshold
  INTO v_free_ship_enabled, v_free_ship_threshold
  FROM public.site_settings WHERE store_id = p_store_id;
  IF v_free_ship_threshold IS NOT NULL AND COALESCE(v_free_ship_enabled, true) AND v_subtotal >= v_free_ship_threshold THEN
    v_shipping_fee := 0;
  END IF;

  -- 6. Calculate total
  v_total := v_subtotal + v_shipping_fee - v_discount;
  IF v_total < 0 THEN
    v_total := 0;
  END IF;

  -- 7. Insert Order
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

  -- 8. Deduct stock & insert order_items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT price, name INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

    UPDATE public.products
    SET stock_quantity = stock_quantity - (v_item->>'qty')::int
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
      AND stock_quantity >= (v_item->>'qty')::int;

    INSERT INTO public.order_items (order_id, product_id, title, quantity, unit_price)
    VALUES (v_order_id, (v_item->>'id')::uuid, v_product.name, (v_item->>'qty')::int, v_product.price);
  END LOOP;

  RETURN jsonb_build_object('id', v_order_id, 'order_number', v_order_number::text, 'success', true);
END;
$$;
