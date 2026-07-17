-- ============================================================
-- Fix Overloaded create_order_atomic RPC (09_fix_overloaded_rpc.sql)
-- Scope:
--   - Drops all existing signatures of create_order_atomic to remove 
--     ambiguous 11-parameter and 15-parameter versions.
--   - Recreates the exact 12-parameter version.
--   - Prevents PostgREST from matching the wrong signature and throwing 
--     JSON type errors (Token "..." is invalid).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Dynamically drop all existing overloaded versions
-- ------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT oid::regprocedure AS func_signature
        FROM pg_proc
        WHERE proname = 'create_order_atomic'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.func_signature || ' CASCADE;';
    END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 2. Recreate the correct 12-parameter signature
-- ------------------------------------------------------------
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
  p_store_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_item jsonb;
  v_order_number bigint;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_coupon_id uuid := NULL;
  v_shipping_fee numeric := 0;
  v_total numeric := 0;
  v_product record;
  v_coupon record;
  v_qty integer;
BEGIN
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

  IF p_payment_method NOT IN ('cod', 'card', 'cash_on_delivery') THEN
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
    v_qty := COALESCE((v_item->>'qty')::integer, 0);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'Invalid item quantity';
    END IF;

    SELECT id, name, price, stock_quantity, is_active, COALESCE(is_deleted, false) AS is_deleted
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
    IF COALESCE(v_product.stock_quantity, 0) < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for product: %', v_product.name;
    END IF;

    v_subtotal := v_subtotal + (COALESCE(v_product.price, 0) * v_qty);
  END LOOP;

  IF p_coupon_code IS NOT NULL AND length(trim(p_coupon_code)) > 0 THEN
    SELECT *
    INTO v_coupon
    FROM public.coupons
    WHERE upper(code) = upper(trim(p_coupon_code))
      AND store_id = p_store_id
      AND is_active = true
      FOR UPDATE;

    IF FOUND THEN
      IF (v_coupon.expiry_date IS NULL OR v_coupon.expiry_date > now())
        AND COALESCE(v_coupon.used_count, 0) < COALESCE(NULLIF(v_coupon.max_uses, 0), 2147483647)
        AND v_subtotal >= COALESCE(v_coupon.min_order_value, 0)
      THEN
        v_coupon_id := v_coupon.id;
        v_discount := CASE
          WHEN COALESCE(v_coupon.discount_percentage, 0) > 0 THEN v_subtotal * (v_coupon.discount_percentage / 100)
          ELSE COALESCE(v_coupon.discount_amount, 0)
        END;
        v_discount := LEAST(v_discount, v_subtotal);
        UPDATE public.coupons SET used_count = COALESCE(used_count, 0) + 1 WHERE id = v_coupon.id;
      END IF;
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

  v_total := GREATEST(v_subtotal + v_shipping_fee - v_discount, 0);

  INSERT INTO public.orders (
    user_id, phone, city, address, customer_note, payment_method,
    subtotal, discount, discount_amount, shipping_fee, total, total_amount,
    coupon_id, idempotency_key, order_number, status, payment_status,
    auth_source, metadata, items, store_id
  )
  VALUES (
    p_user_id, p_phone, p_city, p_address, COALESCE(p_customer_note, ''), p_payment_method,
    v_subtotal, v_discount, v_discount, v_shipping_fee, v_total, v_total,
    v_coupon_id, p_idempotency_key, v_order_number, 'pending',
    CASE WHEN p_payment_method = 'cod' OR p_payment_method = 'cash_on_delivery' THEN 'unpaid' ELSE 'pending' END,
    p_auth_source, COALESCE(p_metadata, '{}'::jsonb), p_items, p_store_id
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;

    SELECT id, name, price
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

    UPDATE public.products
    SET stock_quantity = stock_quantity - v_qty,
        stock = GREATEST(COALESCE(stock, stock_quantity) - v_qty, 0)
    WHERE id = v_product.id AND store_id = p_store_id AND stock_quantity >= v_qty;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock update failed';
    END IF;

    INSERT INTO public.order_items (order_id, product_id, title, quantity, unit_price, store_id)
    VALUES (v_order_id, v_product.id, v_product.name, v_qty, v_product.price, p_store_id);

    INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
    VALUES (v_product.id, v_order_id, NULL, -v_qty, 'sale', p_store_id);
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
$$;

REVOKE ALL ON FUNCTION public.create_order_atomic(uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid) TO anon, authenticated, service_role;

COMMIT;
