-- Migration 104: Enterprise RBAC, Staff Management, POS Transaction Identity & Cash Refunds
-- Created: 2026-09-09

-- 1. Ensure orders table has cashier_user_id
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS cashier_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_cashier_user ON public.orders (cashier_user_id);

-- 2. Ensure pos_shifts table has separate refund columns
ALTER TABLE public.pos_shifts
ADD COLUMN IF NOT EXISTS cash_refunds numeric NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS card_refunds numeric NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_refunds numeric NOT NULL DEFAULT 0;

-- 3. Ensure store_staff table has all required columns and constraints
CREATE TABLE IF NOT EXISTS public.store_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.store_staff
ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS role_name text NOT NULL DEFAULT 'cashier',
ADD COLUMN IF NOT EXISTS invited_email text,
ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_store_staff_store_id ON public.store_staff (store_id);
CREATE INDEX IF NOT EXISTS idx_store_staff_user_id ON public.store_staff (user_id);

-- 4. Atomic Staff Creation with Strict Server-Side Quota Enforcement
CREATE OR REPLACE FUNCTION public.create_store_staff_atomic(
  p_store_id uuid,
  p_user_id uuid,
  p_email text,
  p_role_name text DEFAULT 'cashier'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_store RECORD;
  v_sub RECORD;
  v_active_staff_count integer;
  v_plan_limit bigint;
  v_limit_check RECORD;
  v_role_id uuid;
  v_staff_id uuid;
BEGIN
  -- 1. Lock store row to prevent concurrent race conditions
  SELECT id, name, subdomain INTO v_store
  FROM public.stores
  WHERE id = p_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Store not found';
  END IF;

  -- 2. Check active store subscription and lock subscription row
  SELECT id, plan_id, status INTO v_sub
  FROM public.store_subscriptions
  WHERE store_id = p_store_id
  ORDER BY (status = 'active') DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- Count existing active staff (excluding store owner)
  SELECT count(*) INTO v_active_staff_count
  FROM public.store_staff
  WHERE store_id = p_store_id AND is_active = true;

  -- Synchronize feature_usage with actual active staff count
  UPDATE public.feature_usage
  SET usage_count = v_active_staff_count, updated_at = now()
  WHERE store_id = p_store_id AND feature_key = 'employees';

  -- 3. Check feature limit using canonical limit function
  SELECT * INTO v_limit_check
  FROM public.check_feature_limit(p_store_id, 'employees', 1);

  -- If check_feature_limit returned allowed = false OR active staff already >= limit_value, reject immediately
  IF v_limit_check.allowed = false OR (v_limit_check.limit_value IS NOT NULL AND v_limit_check.is_unlimited = false AND v_active_staff_count >= v_limit_check.limit_value) THEN
    RAISE EXCEPTION 'PLAN_LIMIT_REACHED: لقد استنفد المتجر الحد الأقصى للموظفين المسموح بهم في باقته الحالية (% / %)',
      v_active_staff_count, coalesce(v_limit_check.limit_value, 1);
  END IF;

  -- 4. Resolve the target role_id
  SELECT id INTO v_role_id
  FROM public.roles
  WHERE name = lower(trim(p_role_name))
    AND role_type IN ('tenant', 'tenant_template')
  ORDER BY (role_type = 'tenant') DESC
  LIMIT 1;

  IF v_role_id IS NULL THEN
    -- Fallback to cashier role
    SELECT id INTO v_role_id
    FROM public.roles
    WHERE name = 'cashier'
      AND role_type IN ('tenant', 'tenant_template')
    LIMIT 1;
  END IF;

  -- 5. Insert or update into store_staff
  INSERT INTO public.store_staff (
    store_id, user_id, role_id, role_name, invited_email, is_active, updated_at
  )
  VALUES (
    p_store_id, p_user_id, v_role_id, coalesce(p_role_name, 'cashier'), lower(trim(p_email)), true, now()
  )
  ON CONFLICT (store_id, user_id) DO UPDATE SET
    role_id = EXCLUDED.role_id,
    role_name = EXCLUDED.role_name,
    invited_email = EXCLUDED.invited_email,
    is_active = true,
    updated_at = now()
  RETURNING id INTO v_staff_id;

  -- 6. Grant role in user_roles
  IF p_user_id IS NOT NULL AND v_role_id IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, store_id, role_id)
    VALUES (p_user_id, p_store_id, v_role_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'staff_id', v_staff_id,
    'user_id', p_user_id,
    'role_name', p_role_name,
    'store_id', p_store_id,
    'active_staff_count', v_active_staff_count + 1,
    'limit_value', v_limit_check.limit_value
  );
END;
$$;

-- 5. Update create_pos_return_atomic: Record returns into cash_refunds, NOT pay_outs!
CREATE OR REPLACE FUNCTION public.create_pos_return_atomic(
  p_store_id uuid,
  p_order_id uuid,
  p_user_id uuid,
  p_items jsonb,
  p_refund_method text DEFAULT 'cash',
  p_reason text DEFAULT 'مرتجع كاشير'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_item jsonb;
  v_product RECORD;
  v_total_refund numeric := 0;
  v_return_id uuid;
  v_return_number text;
  v_shift RECORD;
  v_qty integer;
  v_condition text;
  v_item_price numeric;
BEGIN
  -- 1. Validate order exists and belongs to this store
  SELECT id, order_number, total, items
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND store_id = p_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or does not belong to this store';
  END IF;

  -- 2. Process items and calculate total refund
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;
    v_condition := coalesce(v_item->>'condition', 'sound');
    v_item_price := (v_item->>'price')::numeric;

    IF v_qty < 1 THEN
      RAISE EXCEPTION 'Invalid return quantity';
    END IF;

    v_total_refund := v_total_refund + (v_item_price * v_qty);

    -- Restock inventory if condition is sound
    IF (v_item->>'id') IS NOT NULL OR (v_item->>'product_id') IS NOT NULL THEN
      SELECT id, name, stock_quantity, stock
      INTO v_product
      FROM public.products
      WHERE id = COALESCE((v_item->>'id')::uuid, (v_item->>'product_id')::uuid) AND store_id = p_store_id
      FOR UPDATE;

      IF FOUND THEN
        IF v_condition = 'sound' THEN
          UPDATE public.products
          SET stock_quantity = stock_quantity + v_qty,
              stock = COALESCE(stock, stock_quantity) + v_qty
          WHERE id = v_product.id;

          INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
          VALUES (v_product.id, p_order_id, p_user_id, v_qty, 'return', p_store_id);
        ELSE
          INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
          VALUES (v_product.id, p_order_id, p_user_id, 0, 'correction', p_store_id);
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Generate return number
  v_return_number := 'RET-' || v_order.order_number || '-' || TO_CHAR(now(), 'HH24MI');

  -- 3. Insert record into pos_returns
  INSERT INTO public.pos_returns (
    store_id, order_id, return_number, items, total_refund, refund_method, reason, cashier_user_id
  )
  VALUES (
    p_store_id, p_order_id, v_return_number, p_items, v_total_refund, p_refund_method, p_reason, p_user_id
  )
  RETURNING id INTO v_return_id;

  -- 4. Record order tracking
  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (
    p_order_id,
    'refunded',
    'مرتجع كاشير بقيمة ' || v_total_refund || ' ج.م برقم ' || v_return_number,
    p_store_id
  );

  -- 5. If an active shift is open, update cash_refunds or card_refunds (NEVER pay_outs!)
  SELECT id, cash_refunds, card_refunds, total_refunds
  INTO v_shift
  FROM public.pos_shifts
  WHERE store_id = p_store_id AND status = 'open'
  ORDER BY opened_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF p_refund_method = 'card' THEN
      UPDATE public.pos_shifts
      SET card_refunds = card_refunds + v_total_refund,
          total_refunds = total_refunds + v_total_refund,
          updated_at = now()
      WHERE id = v_shift.id;
    ELSE
      UPDATE public.pos_shifts
      SET cash_refunds = cash_refunds + v_total_refund,
          total_refunds = total_refunds + v_total_refund,
          updated_at = now()
      WHERE id = v_shift.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'order_id', p_order_id,
    'total_refund', v_total_refund,
    'refund_method', p_refund_method,
    'items_count', jsonb_array_length(p_items),
    'success', true
  );
END;
$$;

-- 6. Update create_pos_order_atomic: Separate customer user_id from cashier_user_id!
CREATE OR REPLACE FUNCTION public.create_pos_order_atomic(
  p_store_id uuid,
  p_user_id uuid, -- Cashier user id
  p_items jsonb,
  p_payment_method text DEFAULT 'cash'::text,
  p_discount_amount numeric DEFAULT 0,
  p_customer_name text DEFAULT 'عميل نقدي'::text,
  p_customer_phone text DEFAULT NULL::text,
  p_notes text DEFAULT ''::text,
  p_cash_tendered numeric DEFAULT NULL::numeric,
  p_change_due numeric DEFAULT NULL::numeric,
  p_customer_user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id uuid;
  v_order_number bigint;
  v_subtotal numeric := 0;
  v_total numeric := 0;
  v_discount numeric := 0;
  v_item jsonb;
  v_product RECORD;
  v_variant RECORD;
  v_qty integer;
  v_item_price numeric;
  v_item_cost numeric := 0;
  v_item_name text;
  v_variant_title text := NULL;
  v_enriched_items jsonb := '[]'::jsonb;
  v_shift RECORD;
  v_meta jsonb;
  v_cashier_name text := 'كاشير الفرع';
BEGIN
  -- Validate store
  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'Store ID is required';
  END IF;

  -- Resolve cashier name from auth.users or store_staff if available
  IF p_user_id IS NOT NULL THEN
    SELECT coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', email, 'كاشير')
    INTO v_cashier_name
    FROM auth.users
    WHERE id = p_user_id;
  END IF;

  IF v_cashier_name IS NULL OR v_cashier_name = '' THEN
    v_cashier_name := 'كاشير الفرع';
  END IF;

  -- 1. Counter for order_number
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

  -- 2. Validate products and variants with row locking
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, (v_item->>'quantity')::integer, 0);
    IF v_qty < 1 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', COALESCE(v_item->>'name', v_item->>'title', 'Unknown');
    END IF;

    SELECT id, name, price, cost_price, stock_quantity, stock, is_active, COALESCE(is_deleted, false) AS is_deleted, has_variants
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found in this store', COALESCE(v_item->>'name', v_item->>'id');
    END IF;

    IF v_product.is_deleted OR NOT v_product.is_active THEN
      RAISE EXCEPTION 'Product % is inactive or deleted', v_product.name;
    END IF;

    -- Check if item has specific variant
    IF (v_item->>'variant_id') IS NOT NULL AND (v_item->>'variant_id') <> '' THEN
      SELECT pv.id, pv.price, pv.cost_price, pv.stock_quantity, pv.sku, pv.barcode,
             string_agg(po.name || ': ' || pov.name, ' / ' ORDER BY po.display_order, pov.display_order) AS option_summary
      INTO v_variant
      FROM public.product_variants pv
      LEFT JOIN public.product_variant_option_values pvov ON pvov.variant_id = pv.id
      LEFT JOIN public.product_options po ON po.id = pvov.option_id
      LEFT JOIN public.product_option_values pov ON pov.id = pvov.option_value_id
      WHERE pv.id = (v_item->>'variant_id')::uuid
        AND pv.product_id = v_product.id
        AND pv.store_id = p_store_id
        AND pv.is_archived = false
      GROUP BY pv.id, pv.price, pv.cost_price, pv.stock_quantity, pv.sku, pv.barcode
      FOR UPDATE OF pv;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found or archived for product %', v_product.name;
      END IF;

      IF v_variant.stock_quantity < v_qty THEN
        RAISE EXCEPTION 'Not enough stock for variant: % (%) - Available: %',
          v_product.name, coalesce(v_variant.option_summary, 'Default'), v_variant.stock_quantity;
      END IF;

      v_item_price := COALESCE(v_variant.price, v_product.price);
      v_item_cost := COALESCE(v_variant.cost_price, v_product.cost_price, 0);
      v_variant_title := v_variant.option_summary;
    ELSE
      IF v_product.has_variants THEN
        RAISE EXCEPTION 'Product % has variants; specific variant selection required', v_product.name;
      END IF;

      IF COALESCE(v_product.stock_quantity, v_product.stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Not enough stock for product: % - Available: %',
          v_product.name, COALESCE(v_product.stock_quantity, v_product.stock, 0);
      END IF;

      v_item_price := v_product.price;
      v_item_cost := COALESCE(v_product.cost_price, 0);
      v_variant_title := NULL;
    END IF;

    v_item_name := COALESCE(v_item->>'name', v_product.name);
    v_subtotal := v_subtotal + (v_item_price * v_qty);

    v_enriched_items := v_enriched_items || jsonb_build_array(jsonb_build_object(
      'id', v_product.id,
      'product_id', v_product.id,
      'variant_id', CASE WHEN (v_item->>'variant_id') IS NOT NULL AND (v_item->>'variant_id') <> '' THEN (v_item->>'variant_id')::uuid ELSE NULL END,
      'name', v_item_name,
      'price', v_item_price,
      'cost_price', v_item_cost,
      'qty', v_qty,
      'total', v_item_price * v_qty,
      'variant_title', v_variant_title
    ));
  END LOOP;

  -- Apply discount
  v_discount := LEAST(COALESCE(p_discount_amount, 0), v_subtotal);
  v_total := GREATEST(v_subtotal - v_discount, 0);

  -- 3. Construct rich audit metadata
  v_meta := jsonb_build_object(
    'channel', 'pos',
    'cashier_user_id', p_user_id,
    'cashier_name', v_cashier_name,
    'customer_name', COALESCE(p_customer_name, 'عميل نقدي'),
    'cash_tendered', p_cash_tendered,
    'change_due', p_change_due,
    'source', 'pos_terminal'
  );

  -- 4. Insert order record:
  -- CRITICAL FIX: user_id = p_customer_user_id (NULL for cash counter guest customers)
  -- cashier_user_id = p_user_id (References real auth.users staff member)
  INSERT INTO public.orders (
    user_id, cashier_user_id, phone, city, address, customer_note, payment_method,
    subtotal, discount, discount_amount, shipping_fee, total, total_amount,
    order_number, status, payment_status,
    auth_source, metadata, items, store_id
  )
  VALUES (
    p_customer_user_id, p_user_id, COALESCE(p_customer_phone, '01000000000'), 'استلام من الفرع', 'مبيعات الكاشير المباشرة (POS)', COALESCE(p_notes, ''),
    CASE WHEN p_payment_method = 'card' THEN 'card' ELSE 'cod' END,
    v_subtotal, v_discount, v_discount, 0, v_total, v_total,
    v_order_number, 'delivered', 'paid',
    'pos', v_meta, v_enriched_items, p_store_id
  )
  RETURNING id INTO v_order_id;

  -- 5. Decrement inventory atomically and record order_items
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_enriched_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;
    v_item_price := (v_item->>'price')::numeric;
    v_item_cost := (v_item->>'cost_price')::numeric;

    -- If variant, decrement variant stock (trigger automatically synchronizes parent)
    IF (v_item->>'variant_id') IS NOT NULL THEN
      UPDATE public.product_variants
      SET stock_quantity = stock_quantity - v_qty,
          updated_at = now()
      WHERE id = (v_item->>'variant_id')::uuid AND store_id = p_store_id;

      INSERT INTO public.order_items (
        order_id, product_id, variant_id, title, quantity, unit_price, store_id,
        unit_cost_snapshot, gross_profit, variant_title_snapshot
      )
      VALUES (
        v_order_id,
        (v_item->>'id')::uuid,
        (v_item->>'variant_id')::uuid,
        v_item->>'name',
        v_qty,
        v_item_price,
        p_store_id,
        v_item_cost,
        (v_item_price - v_item_cost) * v_qty,
        v_item->>'variant_title'
      );
    ELSE
      UPDATE public.products
      SET stock_quantity = GREATEST(COALESCE(stock_quantity, stock, 0) - v_qty, 0),
          stock = GREATEST(COALESCE(stock, stock_quantity, 0) - v_qty, 0),
          updated_at = now()
      WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

      INSERT INTO public.order_items (
        order_id, product_id, title, quantity, unit_price, store_id,
        unit_cost_snapshot, gross_profit
      )
      VALUES (
        v_order_id,
        (v_item->>'id')::uuid,
        v_item->>'name',
        v_qty,
        v_item_price,
        p_store_id,
        v_item_cost,
        (v_item_price - v_item_cost) * v_qty
      );
    END IF;

    INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
    VALUES ((v_item->>'id')::uuid, v_order_id, p_user_id, -v_qty, 'sale', p_store_id);
  END LOOP;

  -- 6. Order tracking
  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (v_order_id, 'delivered', 'تم إتمام البيع واستلام المبلغ عبر الكاشير (POS)', p_store_id);

  -- 7. Update active shift cash/card sales
  SELECT id, cash_sales, card_sales, total_sales
  INTO v_shift
  FROM public.pos_shifts
  WHERE store_id = p_store_id AND status = 'open'
  ORDER BY opened_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF p_payment_method = 'card' THEN
      UPDATE public.pos_shifts
      SET card_sales = card_sales + v_total,
          total_sales = total_sales + v_total,
          updated_at = now()
      WHERE id = v_shift.id;
    ELSE
      UPDATE public.pos_shifts
      SET cash_sales = cash_sales + v_total,
          total_sales = total_sales + v_total,
          updated_at = now()
      WHERE id = v_shift.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number::text,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'total', v_total,
    'status', 'delivered',
    'payment_status', 'paid',
    'cashier_name', v_cashier_name,
    'cashier_user_id', p_user_id,
    'success', true
  );
END;
$$;
