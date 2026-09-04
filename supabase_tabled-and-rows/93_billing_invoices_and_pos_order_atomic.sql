-- Migration 93: Billing Invoices and POS Atomic Function
-- Adds invoice payment proof columns and implements atomic in-store POS cashier sales

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS proof_url text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS proof_submitted_at timestamptz;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS billing_cycle text DEFAULT 'monthly';

CREATE OR REPLACE FUNCTION public.create_pos_order_atomic(
  p_store_id uuid,
  p_user_id uuid,
  p_items jsonb,
  p_payment_method text DEFAULT 'cash',
  p_discount_amount numeric DEFAULT 0,
  p_customer_name text DEFAULT 'عميل نقدي',
  p_customer_phone text DEFAULT NULL,
  p_notes text DEFAULT '',
  p_cash_tendered numeric DEFAULT NULL,
  p_change_due numeric DEFAULT NULL
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
BEGIN
  IF p_store_id IS NULL THEN
    RAISE EXCEPTION 'Store ID is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'POS cart is empty';
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

    SELECT id, name, price, stock_quantity, is_active, COALESCE(is_deleted, false) AS is_deleted
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

    IF COALESCE(v_product.stock_quantity, 0) < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for product: % (Available: %)', v_product.name, COALESCE(v_product.stock_quantity, 0);
    END IF;

    v_subtotal := v_subtotal + (COALESCE((v_item->>'price')::numeric, v_product.price, 0) * v_qty);
  END LOOP;

  v_discount := LEAST(v_discount, v_subtotal);
  v_total := GREATEST(v_subtotal - v_discount, 0);

  v_meta := jsonb_build_object(
    'channel', 'pos',
    'cashier_user_id', p_user_id,
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
    'pos', v_meta, p_items, p_store_id
  )
  RETURNING id INTO v_order_id;

  -- 4. Decrement inventory and insert order_items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, (v_item->>'quantity')::integer, 0);

    SELECT id, name, price
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

    UPDATE public.products
    SET stock_quantity = stock_quantity - v_qty,
        stock = GREATEST(COALESCE(stock, stock_quantity) - v_qty, 0)
    WHERE id = v_product.id AND store_id = p_store_id;

    INSERT INTO public.order_items (order_id, product_id, title, quantity, unit_price, store_id)
    VALUES (v_order_id, v_product.id, v_product.name, v_qty, COALESCE((v_item->>'price')::numeric, v_product.price, 0), p_store_id);

    INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
    VALUES (v_product.id, v_order_id, p_user_id, -v_qty, 'sale_pos', p_store_id);
  END LOOP;

  -- 5. Order tracking
  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (v_order_id, 'delivered', 'تم إتمام البيع واستلام المبلغ عبر الكاشير (POS)', p_store_id);

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number::text,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'total', v_total,
    'status', 'delivered',
    'payment_status', 'paid',
    'success', true
  );
END;
$function$;
