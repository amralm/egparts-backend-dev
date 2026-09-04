-- Migration 96: POS Shifts, Cash Drawer Movements, and Atomic Returns
-- Supports Shift Management (Z-Report), Safe Cash Drawer Movements, and Inventory-Restoring Returns

-- 1. Table pos_shifts
CREATE TABLE IF NOT EXISTS public.pos_shifts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  cashier_user_id uuid,
  cashier_name text NOT NULL DEFAULT 'الكاشير',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_cash numeric NOT NULL DEFAULT 0,
  pay_ins numeric NOT NULL DEFAULT 0,
  pay_outs numeric NOT NULL DEFAULT 0,
  cash_sales numeric NOT NULL DEFAULT 0,
  card_sales numeric NOT NULL DEFAULT 0,
  total_sales numeric NOT NULL DEFAULT 0,
  expected_cash numeric NOT NULL DEFAULT 0,
  actual_cash numeric,
  difference numeric,
  notes text DEFAULT '',
  cash_movements jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pos_shifts_store_status_idx ON public.pos_shifts(store_id, status);
CREATE INDEX IF NOT EXISTS pos_shifts_opened_at_idx ON public.pos_shifts(store_id, opened_at DESC);

-- 2. Table pos_returns
CREATE TABLE IF NOT EXISTS public.pos_returns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  return_number text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_refund numeric NOT NULL DEFAULT 0,
  refund_method text NOT NULL DEFAULT 'cash' CHECK (refund_method IN ('cash', 'card', 'exchange')),
  reason text DEFAULT '',
  cashier_user_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pos_returns_store_order_idx ON public.pos_returns(store_id, order_id);
CREATE INDEX IF NOT EXISTS pos_returns_created_at_idx ON public.pos_returns(store_id, created_at DESC);

-- 3. Atomic Return Function
CREATE OR REPLACE FUNCTION public.create_pos_return_atomic(
  p_store_id uuid,
  p_order_id uuid,
  p_user_id uuid,
  p_items jsonb,
  p_refund_method text DEFAULT 'cash',
  p_reason text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order record;
  v_item jsonb;
  v_product record;
  v_qty integer;
  v_price numeric;
  v_condition text;
  v_total_refund numeric := 0;
  v_return_id uuid;
  v_return_number text;
  v_shift record;
BEGIN
  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'Store ID is required';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order ID is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Return items list cannot be empty';
  END IF;

  -- 1. Fetch and lock original order
  SELECT id, order_number, total, subtotal, status, items
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND store_id = p_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original order not found in this store';
  END IF;

  -- 2. Validate items, calculate refund and adjust stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, 0);
    v_price := COALESCE((v_item->>'price')::numeric, (v_item->>'unit_price')::numeric, 0);
    v_condition := COALESCE(v_item->>'condition', 'sound'); -- 'sound' or 'damaged'

    IF v_qty < 1 THEN
      RAISE EXCEPTION 'Invalid return quantity for item %', COALESCE(v_item->>'name', v_item->>'title', 'Unknown');
    END IF;

    v_total_refund := v_total_refund + (v_price * v_qty);

    -- If product exists, adjust inventory based on condition
    IF (v_item->>'id') IS NOT NULL OR (v_item->>'product_id') IS NOT NULL THEN
      SELECT id, name, stock_quantity, stock
      INTO v_product
      FROM public.products
      WHERE id = COALESCE((v_item->>'id')::uuid, (v_item->>'product_id')::uuid) AND store_id = p_store_id
      FOR UPDATE;

      IF FOUND THEN
        IF v_condition = 'sound' THEN
          -- Sound item: restore to sellable stock
          UPDATE public.products
          SET stock_quantity = stock_quantity + v_qty,
              stock = COALESCE(stock, stock_quantity) + v_qty
          WHERE id = v_product.id;

          INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
          VALUES (v_product.id, p_order_id, p_user_id, v_qty, 'return', p_store_id);
        ELSE
          -- Damaged item: log correction adjustment without increasing sellable stock
          INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
          VALUES (v_product.id, p_order_id, p_user_id, 0, 'correction', p_store_id);
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Generate return number (e.g. RET-1001-1)
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

  -- 5. If an active shift is open, adjust shift pay_outs and cash
  SELECT id, pay_outs, cash_sales
  INTO v_shift
  FROM public.pos_shifts
  WHERE store_id = p_store_id AND status = 'open'
  ORDER BY opened_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts
    SET pay_outs = pay_outs + v_total_refund,
        updated_at = now()
    WHERE id = v_shift.id;
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
$function$;

-- 4. Update create_pos_order_atomic to seamlessly increment active shift cash/card sales
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
  v_qty integer;
  v_meta jsonb;
  v_enriched_items jsonb := '[]'::jsonb;
  v_item_price numeric;
  v_cashier_name text := 'كاشير الفرع';
  v_shift record;
BEGIN
  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'Store ID is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'POS cart is empty';
  END IF;

  -- Lookup cashier name
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

  -- 2. Validate products and calculate subtotal with row locking
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, (v_item->>'quantity')::integer, 0);
    IF v_qty < 1 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', COALESCE(v_item->>'name', v_item->>'title', 'Unknown');
    END IF;

    SELECT id, name, price, stock_quantity, stock, is_active, COALESCE(is_deleted, false) AS is_deleted
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

    IF COALESCE(v_product.stock_quantity, v_product.stock, 0) < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for product: % (Available: %)', v_product.name, COALESCE(v_product.stock_quantity, v_product.stock, 0);
    END IF;

    v_item_price := COALESCE((v_item->>'price')::numeric, v_product.price, 0);
    v_subtotal := v_subtotal + (v_item_price * v_qty);

    v_enriched_items := v_enriched_items || jsonb_build_array(jsonb_build_object(
      'id', v_product.id,
      'name', v_product.name,
      'title', v_product.name,
      'price', v_item_price,
      'qty', v_qty
    ));
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

  -- 3. Insert order record (delivered & paid)
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

  -- 4. Decrement inventory and insert order_items (using reason = 'sale')
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_enriched_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;
    v_item_price := (v_item->>'price')::numeric;

    SELECT id, name, price, cost_price
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

    UPDATE public.products
    SET stock_quantity = GREATEST(COALESCE(stock_quantity, stock, 0) - v_qty, 0),
        stock = GREATEST(COALESCE(stock, stock_quantity, 0) - v_qty, 0)
    WHERE id = v_product.id AND store_id = p_store_id;

    INSERT INTO public.order_items (
      order_id, product_id, title, quantity, unit_price, store_id, unit_cost_snapshot, gross_profit
    )
    VALUES (
      v_order_id,
      v_product.id,
      v_product.name,
      v_qty,
      v_item_price,
      p_store_id,
      COALESCE(v_product.cost_price, 0),
      (v_item_price - COALESCE(v_product.cost_price, 0)) * v_qty
    );

    INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
    VALUES (v_product.id, v_order_id, p_user_id, -v_qty, 'sale', p_store_id);
  END LOOP;

  -- 5. Order tracking
  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (v_order_id, 'delivered', 'تم إتمام البيع واستلام المبلغ عبر الكاشير (POS)', p_store_id);

  -- 6. Update open shift if one exists
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
    'success', true
  );
END;
$function$;
