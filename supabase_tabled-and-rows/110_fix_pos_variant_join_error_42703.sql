-- 110_fix_pos_variant_join_error_42703.sql
-- Fix PostgreSQL 42703 column pvov.option_id and FOR UPDATE with GROUP BY in create_pos_order_atomic

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
      SELECT pv.id, pv.price, pv.cost_price, pv.stock_quantity, pv.sku, pv.barcode, pv.title AS option_summary
      INTO v_variant
      FROM public.product_variants pv
      WHERE pv.id = (v_item->>'variant_id')::uuid
        AND pv.product_id = v_product.id
        AND pv.store_id = p_store_id
        AND pv.is_archived = false
      FOR UPDATE;

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

  -- 4. Insert order record
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
        (v_item->>'name'),
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
        (v_item->>'name'),
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

REVOKE ALL ON FUNCTION public.create_pos_order_atomic(uuid, uuid, jsonb, text, numeric, text, text, text, numeric, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pos_order_atomic(uuid, uuid, jsonb, text, numeric, text, text, text, numeric, numeric, uuid) TO service_role;
