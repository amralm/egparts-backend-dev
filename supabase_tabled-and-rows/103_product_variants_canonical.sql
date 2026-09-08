-- Migration 103: Canonical Product Options, Variants, and Store Barcode Registry
-- Enforces tenant-scoped composite foreign keys, single authoritative stock derivation,
-- store-wide atomic barcode uniqueness, and deadlock-free atomic order execution.

-- 1. Ensure products table has required columns and unique constraint on (id, store_id)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'has_variants') THEN
    ALTER TABLE public.products ADD COLUMN has_variants boolean NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'options_summary') THEN
    ALTER TABLE public.products ADD COLUMN options_summary jsonb DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Composite unique constraint on products(id, store_id) required for tenant-scoped composite foreign keys
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_products_id_store'
  ) THEN
    ALTER TABLE public.products ADD CONSTRAINT uq_products_id_store UNIQUE (id, store_id);
  END IF;
END $$;

-- 2. Table: product_options
CREATE TABLE IF NOT EXISTS public.product_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_options_product_store 
    FOREIGN KEY (product_id, store_id) REFERENCES public.products(id, store_id) ON DELETE CASCADE,
  CONSTRAINT uq_product_options_id_product_store UNIQUE (id, product_id, store_id),
  CONSTRAINT uq_product_options_name_per_product UNIQUE (product_id, normalized_name)
);

-- 3. Table: product_option_values
CREATE TABLE IF NOT EXISTS public.product_option_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  option_id uuid NOT NULL,
  product_id uuid NOT NULL,
  store_id uuid NOT NULL,
  value text NOT NULL,
  normalized_value text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_option_values_option_scope 
    FOREIGN KEY (option_id, product_id, store_id) REFERENCES public.product_options(id, product_id, store_id) ON DELETE CASCADE,
  CONSTRAINT uq_product_option_values_id_product_store UNIQUE (id, product_id, store_id),
  CONSTRAINT uq_option_values_val_per_option UNIQUE (option_id, normalized_value)
);

-- 4. Table: product_variants
CREATE TABLE IF NOT EXISTS public.product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  store_id uuid NOT NULL,
  combination_key text NOT NULL,
  title text NOT NULL,
  sku text,
  barcode text,
  price numeric(12, 2),
  old_price numeric(12, 2),
  cost_price numeric(12, 2),
  stock_quantity integer NOT NULL DEFAULT 0,
  image text,
  is_active boolean NOT NULL DEFAULT true,
  is_archived boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_variants_product_store 
    FOREIGN KEY (product_id, store_id) REFERENCES public.products(id, store_id) ON DELETE CASCADE,
  CONSTRAINT chk_stock_non_negative CHECK (stock_quantity >= 0),
  CONSTRAINT chk_old_price_valid CHECK (old_price IS NULL OR price IS NULL OR old_price >= price),
  CONSTRAINT uq_product_variants_id_product_store UNIQUE (id, product_id, store_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_product_variants_combination 
ON public.product_variants (product_id, combination_key) 
WHERE is_archived = false;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_product_variants_store_sku 
ON public.product_variants (store_id, lower(trim(sku))) 
WHERE sku IS NOT NULL AND is_archived = false;

-- 5. Junction Table: product_variant_option_values
CREATE TABLE IF NOT EXISTS public.product_variant_option_values (
  variant_id uuid NOT NULL,
  option_value_id uuid NOT NULL,
  product_id uuid NOT NULL,
  store_id uuid NOT NULL,
  PRIMARY KEY (variant_id, option_value_id),
  CONSTRAINT fk_var_opt_variant_scope 
    FOREIGN KEY (variant_id, product_id, store_id) REFERENCES public.product_variants(id, product_id, store_id) ON DELETE CASCADE,
  CONSTRAINT fk_var_opt_value_scope 
    FOREIGN KEY (option_value_id, product_id, store_id) REFERENCES public.product_option_values(id, product_id, store_id) ON DELETE CASCADE
);

-- 6. Table: store_barcode_registry (Physical Unique B-Tree Index for store-wide barcode concurrency protection)
CREATE TABLE IF NOT EXISTS public.store_barcode_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  barcode text NOT NULL,
  normalized_barcode text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('product', 'variant')),
  entity_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_store_barcode_registry UNIQUE (store_id, normalized_barcode)
);
CREATE INDEX IF NOT EXISTS idx_store_barcode_registry_lookup ON public.store_barcode_registry (store_id, normalized_barcode);

-- 7. Snapshot columns on order_items
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'variant_id') THEN
    ALTER TABLE public.order_items ADD COLUMN variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'variant_title_snapshot') THEN
    ALTER TABLE public.order_items ADD COLUMN variant_title_snapshot text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'selected_options_snapshot') THEN
    ALTER TABLE public.order_items ADD COLUMN selected_options_snapshot jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'sku_snapshot') THEN
    ALTER TABLE public.order_items ADD COLUMN sku_snapshot text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'barcode_snapshot') THEN
    ALTER TABLE public.order_items ADD COLUMN barcode_snapshot text;
  END IF;
END $$;

-- 8. Trigger: guard_derived_product_stock
-- Prevents any direct manual write to products.stock_quantity when has_variants = true
CREATE OR REPLACE FUNCTION public.guard_derived_product_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.has_variants = true THEN
    -- If update is coming from external caller (not from internal sync trigger)
    IF (TG_OP = 'UPDATE' AND NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity AND pg_trigger_depth() <= 1) THEN
      RAISE EXCEPTION 'STOCK_IS_DERIVED: Cannot directly update stock_quantity on a product with variants. Manage variant inventory instead.'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_derived_product_stock ON public.products;
CREATE TRIGGER trg_guard_derived_product_stock
BEFORE UPDATE OF stock_quantity, stock ON public.products
FOR EACH ROW EXECUTE FUNCTION public.guard_derived_product_stock();

-- 9. Trigger: sync_product_variant_stock
-- Bidirectional trigger updating products.stock_quantity = SUM(active, non-archived variants)
CREATE OR REPLACE FUNCTION public.sync_product_variant_stock()
RETURNS TRIGGER AS $$
DECLARE
  v_old_pid uuid;
  v_new_pid uuid;
BEGIN
  IF (TG_OP = 'DELETE' OR TG_OP = 'UPDATE') THEN
    v_old_pid := OLD.product_id;
    UPDATE public.products
    SET stock_quantity = (
      SELECT COALESCE(SUM(stock_quantity), 0)
      FROM public.product_variants
      WHERE product_id = v_old_pid AND is_active = true AND is_archived = false
    ),
    stock = (
      SELECT COALESCE(SUM(stock_quantity), 0)
      FROM public.product_variants
      WHERE product_id = v_old_pid AND is_active = true AND is_archived = false
    ),
    updated_at = now()
    WHERE id = v_old_pid AND has_variants = true;
  END IF;

  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    v_new_pid := NEW.product_id;
    UPDATE public.products
    SET stock_quantity = (
      SELECT COALESCE(SUM(stock_quantity), 0)
      FROM public.product_variants
      WHERE product_id = v_new_pid AND is_active = true AND is_archived = false
    ),
    stock = (
      SELECT COALESCE(SUM(stock_quantity), 0)
      FROM public.product_variants
      WHERE product_id = v_new_pid AND is_active = true AND is_archived = false
    ),
    updated_at = now()
    WHERE id = v_new_pid AND has_variants = true;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_product_variant_stock ON public.product_variants;
CREATE TRIGGER trg_sync_product_variant_stock
AFTER INSERT OR UPDATE OR DELETE ON public.product_variants
FOR EACH ROW EXECUTE FUNCTION public.sync_product_variant_stock();

-- 10. Update create_order_atomic to support variants, deterministic lock ordering,
-- authoritative server pricing, and snapshot capture
CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_user_id uuid,
  p_items jsonb,
  p_phone text,
  p_city text,
  p_address text,
  p_customer_note text DEFAULT ''::text,
  p_payment_method text DEFAULT 'cod'::text,
  p_coupon_code text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_auth_source text DEFAULT 'otp'::text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_store_id uuid DEFAULT NULL::uuid,
  p_location_url text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id uuid;
  v_item jsonb;
  v_order_number bigint;
  v_subtotal numeric := 0;
  v_applicable_subtotal numeric := 0;
  v_discount numeric := 0;
  v_coupon_id uuid := NULL;
  v_shipping_fee numeric := 0;
  v_total numeric := 0;
  v_product record;
  v_variant record;
  v_coupon public.coupons%ROWTYPE;
  v_qty integer;
  v_item_price numeric;
  v_item_cost numeric;
  v_variant_id uuid;
  v_consolidated_items jsonb;
  v_enriched_items jsonb := '[]'::jsonb;
BEGIN
  -- Consolidate duplicate items in cart by (product_id, variant_id) to prevent deadlocks
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id_text, 
      'variant_id', variant_id_text, 
      'qty', total_qty
    ) 
    ORDER BY id_text ASC, COALESCE(variant_id_text, '') ASC
  )
  INTO v_consolidated_items
  FROM (
    SELECT 
      (value->>'id') AS id_text,
      NULLIF(value->>'variant_id', '') AS variant_id_text,
      SUM(COALESCE((value->>'qty')::integer, (value->>'quantity')::integer, 0)) AS total_qty
    FROM jsonb_array_elements(p_items)
    GROUP BY (value->>'id'), NULLIF(value->>'variant_id', '')
  ) grouped;

  p_items := v_consolidated_items;

  -- 0a. Check Store ID is provided
  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'Store ID is required';
  END IF;

  -- 0b. Security validation of p_user_id
  IF auth.uid() IS NULL THEN
    IF p_user_id IS NOT NULL AND auth.role() <> 'service_role' THEN
      RAISE EXCEPTION 'AccessDenied: Cannot assign order to a user without authentication';
    END IF;
  ELSE
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
      IF NOT (
        public.is_super_admin()
        OR auth.role() = 'service_role'
        OR EXISTS (
          SELECT 1 FROM public.store_admins WHERE user_id = auth.uid() AND store_id = p_store_id
        )
        OR EXISTS (
          SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND store_id = p_store_id
        )
      ) THEN
        RAISE EXCEPTION 'AccessDenied: User ID mismatch';
      END IF;
    END IF;
  END IF;

  -- 0c. Validate Store Subscription Active Status
  IF NOT public.is_store_active(p_store_id) THEN
    RAISE EXCEPTION 'Store is not active';
  END IF;

  IF p_payment_method NOT IN ('cod', 'card', 'cash_on_delivery', 'manual_wallet') THEN
    RAISE EXCEPTION 'Unsupported payment method';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  IF p_phone IS NULL OR length(trim(p_phone)) < 8 OR p_city IS NULL OR p_address IS NULL OR length(trim(p_address)) < 2 THEN
    RAISE EXCEPTION 'Delivery data is incomplete';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM public.orders
    WHERE idempotency_key = p_idempotency_key AND store_id = p_store_id;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', v_order_id, 'success', true, 'status', 'already_exists');
    END IF;
  END IF;

  -- If coupon code is provided, fetch and lock coupon upfront for calculation
  IF p_coupon_code IS NOT NULL AND length(trim(p_coupon_code)) > 0 THEN
    SELECT *
    INTO v_coupon
    FROM public.coupons
    WHERE upper(code) = upper(trim(p_coupon_code))
      AND store_id = p_store_id
      AND is_active = true
      FOR UPDATE;

    IF FOUND THEN
      v_coupon_id := v_coupon.id;
    END IF;
  END IF;

  INSERT INTO public.store_counters (store_id, last_order_number)
  VALUES (p_store_id, 0)
  ON CONFLICT (store_id) DO NOTHING;

  SELECT last_order_number + 1 INTO v_order_number
  FROM public.store_counters
  WHERE store_id = p_store_id
  FOR UPDATE;

  UPDATE public.store_counters
  SET last_order_number = v_order_number
  WHERE store_id = p_store_id;

  -- Iterate through items in deterministic sorted order
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, 0);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'Invalid item quantity';
    END IF;

    -- 1. Lock parent product
    SELECT id, name, price, cost_price, stock_quantity, is_active, has_variants, COALESCE(is_deleted, false) AS is_deleted
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found';
    END IF;
    IF v_product.is_active IS FALSE OR v_product.is_deleted IS TRUE THEN
      RAISE EXCEPTION 'Product is unavailable: %', v_product.name;
    END IF;

    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;

    -- 2. If item specifies a variant OR product has variants:
    IF v_variant_id IS NOT NULL THEN
      SELECT id, title, price, cost_price, stock_quantity, sku, barcode, is_active, is_archived
      INTO v_variant
      FROM public.product_variants
      WHERE id = v_variant_id AND product_id = v_product.id AND store_id = p_store_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found for product: %', v_product.name;
      END IF;
      IF v_variant.is_active IS FALSE OR v_variant.is_archived IS TRUE THEN
        RAISE EXCEPTION 'Selected variant is no longer available: % (%)', v_product.name, v_variant.title;
      END IF;
      IF COALESCE(v_variant.stock_quantity, 0) < v_qty THEN
        RAISE EXCEPTION 'Not enough stock for variant: % (%) - Available: %', v_product.name, v_variant.title, v_variant.stock_quantity;
      END IF;

      -- Authoritative price: variant price overrides parent price if set
      v_item_price := ROUND(COALESCE(v_variant.price, v_product.price, 0), 2);
      v_item_cost := ROUND(COALESCE(v_variant.cost_price, v_product.cost_price, 0), 2);

      v_enriched_items := v_enriched_items || jsonb_build_array(
        jsonb_build_object(
          'id', v_product.id,
          'product_id', v_product.id,
          'variant_id', v_variant.id,
          'title', v_product.name,
          'name', v_product.name,
          'variant_title', v_variant.title,
          'variant_title_snapshot', v_variant.title,
          'sku_snapshot', v_variant.sku,
          'barcode_snapshot', v_variant.barcode,
          'qty', v_qty,
          'quantity', v_qty,
          'price', v_item_price,
          'unit_price', v_item_price,
          'unit_cost_snapshot', v_item_cost
        )
      );
    ELSE
      -- Product without variant
      IF v_product.has_variants IS TRUE THEN
        RAISE EXCEPTION 'Product % requires selecting a specific variant (size/color)', v_product.name;
      END IF;
      IF COALESCE(v_product.stock_quantity, 0) < v_qty THEN
        RAISE EXCEPTION 'Not enough stock for product: %', v_product.name;
      END IF;

      v_item_price := ROUND(COALESCE(v_product.price, 0), 2);
      v_item_cost := ROUND(COALESCE(v_product.cost_price, 0), 2);

      v_enriched_items := v_enriched_items || jsonb_build_array(
        jsonb_build_object(
          'id', v_product.id,
          'product_id', v_product.id,
          'title', v_product.name,
          'name', v_product.name,
          'qty', v_qty,
          'quantity', v_qty,
          'price', v_item_price,
          'unit_price', v_item_price,
          'unit_cost_snapshot', v_item_cost
        )
      );
    END IF;

    v_subtotal := v_subtotal + (v_item_price * v_qty);

    -- Track applicable subtotal for specific products coupon
    IF v_coupon_id IS NOT NULL THEN
      IF COALESCE(v_coupon.applies_to, 'all') = 'all' THEN
        v_applicable_subtotal := v_applicable_subtotal + (v_item_price * v_qty);
      ELSIF COALESCE(v_coupon.applicable_product_ids, '[]'::jsonb) ? (v_product.id::text) THEN
        v_applicable_subtotal := v_applicable_subtotal + (v_item_price * v_qty);
      END IF;
    END IF;
  END LOOP;

  -- Calculate discount if coupon conditions are met
  IF v_coupon_id IS NOT NULL THEN
    IF (v_coupon.expiry_date IS NULL OR v_coupon.expiry_date > now())
      AND COALESCE(v_coupon.used_count, 0) < COALESCE(NULLIF(v_coupon.max_uses, 0), 2147483647)
      AND v_subtotal >= COALESCE(v_coupon.min_order_value, 0)
      AND v_applicable_subtotal > 0
    THEN
      v_discount := CASE
        WHEN COALESCE(v_coupon.discount_percentage, 0) > 0 THEN ROUND(v_applicable_subtotal * (v_coupon.discount_percentage / 100.0), 2)
        ELSE ROUND(COALESCE(v_coupon.discount_amount, 0), 2)
      END;

      IF v_coupon.max_discount_cap IS NOT NULL AND v_coupon.max_discount_cap > 0 AND v_discount > v_coupon.max_discount_cap THEN
        v_discount := ROUND(v_coupon.max_discount_cap, 2);
      END IF;

      v_discount := LEAST(v_discount, v_applicable_subtotal);
      UPDATE public.coupons SET used_count = COALESCE(used_count, 0) + 1 WHERE id = v_coupon.id;
    ELSE
      v_coupon_id := NULL;
    END IF;
  END IF;

  SELECT shipping_fee
  INTO v_shipping_fee
  FROM public.shipping_zones
  WHERE store_id = p_store_id AND city_name = p_city AND is_active = true
  LIMIT 1;

  IF v_shipping_fee IS NULL THEN
    SELECT shipping_fee
    INTO v_shipping_fee
    FROM public.shipping_zones
    WHERE store_id = p_store_id AND city_name IN ('محافظة أخرى', 'Other') AND is_active = true
    LIMIT 1;
  END IF;

  v_shipping_fee := COALESCE(v_shipping_fee, 0);

  IF EXISTS (
    SELECT 1
    FROM public.site_settings ss
    WHERE ss.store_id = p_store_id
      AND COALESCE(ss.free_shipping_enabled, true) = true
      AND v_subtotal >= COALESCE(ss.free_shipping_threshold, 0)
  ) THEN
    v_shipping_fee := 0;
  END IF;

  v_subtotal := ROUND(v_subtotal, 2);
  v_discount := ROUND(v_discount, 2);
  v_shipping_fee := ROUND(v_shipping_fee, 2);
  v_total := ROUND(GREATEST(v_subtotal + v_shipping_fee - v_discount, 0), 2);

  INSERT INTO public.orders (
    user_id, phone, city, address, customer_note, payment_method,
    subtotal, discount, discount_amount, shipping_fee, total, total_amount,
    coupon_id, idempotency_key, order_number, status, payment_status,
    auth_source, metadata, items, store_id, location_url
  )
  VALUES (
    p_user_id, p_phone, p_city, p_address, COALESCE(p_customer_note, ''), p_payment_method,
    v_subtotal, v_discount, v_discount, v_shipping_fee, v_total, v_total,
    v_coupon_id, p_idempotency_key, v_order_number, 'pending',
    CASE WHEN p_payment_method = 'cod' OR p_payment_method = 'cash_on_delivery' THEN 'unpaid' ELSE 'pending' END,
    p_auth_source, COALESCE(p_metadata, '{}'::jsonb), v_enriched_items, p_store_id, p_location_url
  )
  RETURNING id INTO v_order_id;

  -- Atomic Inventory Decrement and order_items snapshot insertion
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_enriched_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;
    v_item_price := (v_item->>'price')::numeric;
    v_item_cost := (v_item->>'unit_cost_snapshot')::numeric;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;

    IF v_variant_id IS NOT NULL THEN
      -- Single-statement atomic check and decrement
      UPDATE public.product_variants
      SET stock_quantity = stock_quantity - v_qty, updated_at = now()
      WHERE id = v_variant_id AND product_id = (v_item->>'id')::uuid AND store_id = p_store_id AND stock_quantity >= v_qty;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock update failed for variant %', v_item->>'variant_title_snapshot';
      END IF;

      -- Insert into order_items with all snapshots
      INSERT INTO public.order_items (
        order_id, product_id, variant_id, title, variant_title_snapshot,
        sku_snapshot, barcode_snapshot, quantity, unit_price, store_id,
        unit_cost_snapshot, gross_profit
      )
      VALUES (
        v_order_id, (v_item->>'id')::uuid, v_variant_id, v_item->>'title',
        v_item->>'variant_title_snapshot', v_item->>'sku_snapshot', v_item->>'barcode_snapshot',
        v_qty, v_item_price, p_store_id,
        v_item_cost, ((v_item_price - v_item_cost) * v_qty)
      );

      INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
      VALUES ((v_item->>'id')::uuid, v_order_id, NULL, -v_qty, 'sale', p_store_id);
    ELSE
      -- Non-variant product decrement
      UPDATE public.products
      SET stock_quantity = stock_quantity - v_qty,
          stock = GREATEST(COALESCE(stock, stock_quantity) - v_qty, 0)
      WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id AND COALESCE(stock_quantity, stock, 0) >= v_qty;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock update failed for product %', v_item->>'title';
      END IF;

      INSERT INTO public.order_items (
        order_id, product_id, title, quantity, unit_price, store_id,
        unit_cost_snapshot, gross_profit
      )
      VALUES (
        v_order_id, (v_item->>'id')::uuid, v_item->>'title', v_qty, v_item_price, p_store_id,
        v_item_cost, ((v_item_price - v_item_cost) * v_qty)
      );

      INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
      VALUES ((v_item->>'id')::uuid, v_order_id, NULL, -v_qty, 'sale', p_store_id);
    END IF;
  END LOOP;

  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (v_order_id, 'pending', 'Order created', p_store_id);

  RETURN jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number::text,
    'subtotal', v_subtotal,
    'shipping_fee', v_shipping_fee,
    'discount', v_discount,
    'total', v_total,
    'success', true
  );
END;
$function$;

-- 11. Update restore_order_stock to restore variant stock atomically
CREATE OR REPLACE FUNCTION public.restore_order_stock(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o public.orders%ROWTYPE; 
  item jsonb; 
  pid uuid; 
  vid uuid;
  qty integer; 
  restored integer := 0; 
  coupon_restored boolean := false;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF COALESCE(o.payment_details->>'stock_restored_at', '') <> '' THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'already_restored');
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) LOOP
    pid := NULLIF(COALESCE(item->>'id', item->>'product_id'), '')::uuid;
    vid := NULLIF(item->>'variant_id', '')::uuid;
    qty := GREATEST(COALESCE((item->>'qty')::integer, (item->>'quantity')::integer, 0), 0);

    IF qty > 0 THEN
      IF vid IS NOT NULL THEN
        UPDATE public.product_variants
        SET stock_quantity = stock_quantity + qty, updated_at = now()
        WHERE id = vid AND product_id = pid AND store_id = o.store_id;

        restored := restored + qty;
      ELSIF pid IS NOT NULL THEN
        UPDATE public.products 
        SET stock_quantity = COALESCE(stock_quantity, 0) + qty, updated_at = now()
        WHERE id = pid AND store_id = o.store_id;

        restored := restored + qty;
      END IF;
    END IF;
  END LOOP;

  IF o.coupon_id IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(COALESCE(used_count, 0) - 1, 0)
    WHERE id = o.coupon_id AND store_id = o.store_id AND COALESCE(o.payment_details->>'coupon_restored_at', '') = '';
    coupon_restored := true;
  END IF;

  UPDATE public.orders SET payment_details = COALESCE(payment_details, '{}'::jsonb) || jsonb_build_object(
    'stock_restored_at', now(), 'stock_restored_quantity', restored,
    'coupon_restored_at', CASE WHEN coupon_restored THEN now() ELSE NULL END
  ), updated_at = now() WHERE id = p_order_id;

  RETURN jsonb_build_object('restored', true, 'quantity', restored, 'coupon_restored', coupon_restored);
END; $$;

-- 12. Update create_pos_order_atomic to support variants
CREATE OR REPLACE FUNCTION public.create_pos_order_atomic(
  p_store_id uuid,
  p_user_id uuid,
  p_items jsonb,
  p_payment_method text DEFAULT 'cash'::text,
  p_discount_amount numeric DEFAULT 0,
  p_customer_name text DEFAULT 'عميل نقدي'::text,
  p_customer_phone text DEFAULT NULL::text,
  p_notes text DEFAULT ''::text,
  p_cash_tendered numeric DEFAULT NULL::numeric,
  p_change_due numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id uuid;
  v_item jsonb;
  v_order_number bigint;
  v_subtotal numeric := 0;
  v_discount numeric := COALESCE(p_discount_amount, 0);
  v_total numeric := 0;
  v_product record;
  v_variant record;
  v_qty integer;
  v_meta jsonb;
  v_enriched_items jsonb := '[]'::jsonb;
  v_item_price numeric;
  v_item_cost numeric;
  v_variant_id uuid;
  v_cashier_name text := 'كاشير الفرع';
BEGIN
  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'Store ID is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'POS cart is empty';
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT COALESCE(full_name, 'كاشير الفرع') INTO v_cashier_name
    FROM public.user_profiles
    WHERE user_id = p_user_id AND store_id = p_store_id
    LIMIT 1;

    IF v_cashier_name IS NULL OR v_cashier_name = '' THEN
      SELECT COALESCE(full_name, 'كاشير الفرع') INTO v_cashier_name
      FROM public.user_profiles
      WHERE user_id = p_user_id
      LIMIT 1;
    END IF;
  END IF;
  IF v_cashier_name IS NULL OR v_cashier_name = '' THEN
    v_cashier_name := 'كاشير الفرع';
  END IF;

  INSERT INTO public.store_counters (store_id, last_order_number)
  VALUES (p_store_id, 0)
  ON CONFLICT (store_id) DO NOTHING;

  SELECT last_order_number + 1 INTO v_order_number
  FROM public.store_counters
  WHERE store_id = p_store_id
  FOR UPDATE;

  UPDATE public.store_counters
  SET last_order_number = v_order_number
  WHERE store_id = p_store_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, (v_item->>'quantity')::integer, 0);
    IF v_qty < 1 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', COALESCE(v_item->>'name', v_item->>'title', 'Unknown');
    END IF;

    SELECT id, name, price, cost_price, stock_quantity, stock, is_active, has_variants, COALESCE(is_deleted, false) AS is_deleted
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found in this store', COALESCE(v_item->>'name', v_item->>'id');
    END IF;

    IF v_product.is_active IS FALSE OR v_product.is_deleted IS TRUE THEN
      RAISE EXCEPTION 'Product is unavailable: %', v_product.name;
    END IF;

    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;

    IF v_variant_id IS NOT NULL THEN
      SELECT id, title, price, cost_price, stock_quantity, sku, barcode, is_active, is_archived
      INTO v_variant
      FROM public.product_variants
      WHERE id = v_variant_id AND product_id = v_product.id AND store_id = p_store_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found for product: %', v_product.name;
      END IF;
      IF v_variant.is_active IS FALSE OR v_variant.is_archived IS TRUE THEN
        RAISE EXCEPTION 'Selected variant is unavailable: % (%)', v_product.name, v_variant.title;
      END IF;
      IF COALESCE(v_variant.stock_quantity, 0) < v_qty THEN
        RAISE EXCEPTION 'Not enough stock for variant: % (%)', v_product.name, v_variant.title;
      END IF;

      v_item_price := ROUND(COALESCE(v_variant.price, v_product.price, 0), 2);
      v_item_cost := ROUND(COALESCE(v_variant.cost_price, v_product.cost_price, 0), 2);

      v_subtotal := v_subtotal + (v_item_price * v_qty);

      v_enriched_items := v_enriched_items || jsonb_build_array(jsonb_build_object(
        'id', v_product.id,
        'product_id', v_product.id,
        'variant_id', v_variant.id,
        'name', v_product.name,
        'title', v_product.name,
        'variant_title', v_variant.title,
        'variant_title_snapshot', v_variant.title,
        'sku_snapshot', v_variant.sku,
        'barcode_snapshot', v_variant.barcode,
        'price', v_item_price,
        'unit_price', v_item_price,
        'unit_cost_snapshot', v_item_cost,
        'qty', v_qty
      ));
    ELSE
      IF v_product.has_variants IS TRUE THEN
        RAISE EXCEPTION 'Product % requires choosing a variant', v_product.name;
      END IF;
      IF COALESCE(v_product.stock_quantity, v_product.stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Not enough stock for product: %', v_product.name;
      END IF;

      v_item_price := ROUND(COALESCE(v_product.price, 0), 2);
      v_item_cost := ROUND(COALESCE(v_product.cost_price, 0), 2);

      v_subtotal := v_subtotal + (v_item_price * v_qty);

      v_enriched_items := v_enriched_items || jsonb_build_array(jsonb_build_object(
        'id', v_product.id,
        'product_id', v_product.id,
        'name', v_product.name,
        'title', v_product.name,
        'price', v_item_price,
        'unit_price', v_item_price,
        'unit_cost_snapshot', v_item_cost,
        'qty', v_qty
      ));
    END IF;
  END LOOP;

  v_discount := LEAST(v_discount, v_subtotal);
  v_total := GREATEST(v_subtotal - v_discount, 0);

  v_meta := jsonb_build_object(
    'channel', 'pos',
    'cashier_user_id', p_user_id,
    'cashier_name', v_cashier_name,
    'customer_name', COALESCE(p_customer_name, 'عميل نقدي'),
    'cash_tendered', p_cash_tendered,
    'change_due', p_change_due,
    'source', 'pos_terminal'
  );

  INSERT INTO public.orders (
    user_id, phone, city, address, customer_note, payment_method,
    subtotal, discount, discount_amount, shipping_fee, total, total_amount,
    order_number, status, payment_status,
    auth_source, metadata, items, store_id
  )
  VALUES (
    p_user_id, COALESCE(p_customer_phone, '01000000000'), 'استلام من الفرع', 'مبيعات الكاشير المباشرة (POS)', COALESCE(p_notes, ''),
    CASE WHEN p_payment_method = 'card' THEN 'card' ELSE 'cod' END,
    v_subtotal, v_discount, v_discount, 0, v_total, v_total,
    v_order_number, 'delivered', 'paid',
    'pos', v_meta, v_enriched_items, p_store_id
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_enriched_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;
    v_item_price := (v_item->>'price')::numeric;
    v_item_cost := (v_item->>'unit_cost_snapshot')::numeric;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;

    IF v_variant_id IS NOT NULL THEN
      UPDATE public.product_variants
      SET stock_quantity = stock_quantity - v_qty, updated_at = now()
      WHERE id = v_variant_id AND product_id = (v_item->>'id')::uuid AND store_id = p_store_id AND stock_quantity >= v_qty;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock update failed for variant %', v_item->>'variant_title_snapshot';
      END IF;

      INSERT INTO public.order_items (
        order_id, product_id, variant_id, title, variant_title_snapshot,
        sku_snapshot, barcode_snapshot, quantity, unit_price, store_id,
        unit_cost_snapshot, gross_profit
      )
      VALUES (
        v_order_id, (v_item->>'id')::uuid, v_variant_id, v_item->>'title',
        v_item->>'variant_title_snapshot', v_item->>'sku_snapshot', v_item->>'barcode_snapshot',
        v_qty, v_item_price, p_store_id,
        v_item_cost, ((v_item_price - v_item_cost) * v_qty)
      );

      INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
      VALUES ((v_item->>'id')::uuid, v_order_id, p_user_id, -v_qty, 'sale', p_store_id);
    ELSE
      UPDATE public.products
      SET stock_quantity = stock_quantity - v_qty,
          stock = GREATEST(COALESCE(stock, stock_quantity) - v_qty, 0)
      WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id AND COALESCE(stock_quantity, stock, 0) >= v_qty;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock update failed for product %', v_item->>'title';
      END IF;

      INSERT INTO public.order_items (
        order_id, product_id, title, quantity, unit_price, store_id,
        unit_cost_snapshot, gross_profit
      )
      VALUES (
        v_order_id, (v_item->>'id')::uuid, v_item->>'title', v_qty, v_item_price, p_store_id,
        v_item_cost, ((v_item_price - v_item_cost) * v_qty)
      );

      INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
      VALUES ((v_item->>'id')::uuid, v_order_id, p_user_id, -v_qty, 'sale', p_store_id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number::text,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'total', v_total,
    'success', true
  );
END;
$function$;

-- 13. Enable RLS and grants
ALTER TABLE public.product_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variant_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_barcode_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read on product_options" ON public.product_options;
CREATE POLICY "Allow public read on product_options" ON public.product_options FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow public read on product_option_values" ON public.product_option_values;
CREATE POLICY "Allow public read on product_option_values" ON public.product_option_values FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow public read on active product_variants" ON public.product_variants;
CREATE POLICY "Allow public read on active product_variants" ON public.product_variants FOR SELECT USING (is_active = true AND is_archived = false);
DROP POLICY IF EXISTS "Allow public read on variant option values" ON public.product_variant_option_values;
CREATE POLICY "Allow public read on variant option values" ON public.product_variant_option_values FOR SELECT USING (true);

REVOKE ALL ON FUNCTION public.create_order_atomic(uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid, text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.restore_order_stock(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_order_stock(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_pos_order_atomic(uuid, uuid, jsonb, text, numeric, text, text, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pos_order_atomic(uuid, uuid, jsonb, text, numeric, text, text, text, numeric, numeric) TO service_role;
