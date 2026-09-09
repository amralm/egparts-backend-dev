-- ============================================================================
-- Migration 105: POS Cash Drawer Safety and Manager Override Enforcement
-- Prevents cash returns from causing silent negative cash balances in the drawer.
-- Requires explicit manager override and records authorization audit trail.
-- ============================================================================

-- 1. Ensure columns exist on pos_returns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'pos_returns' AND column_name = 'manager_override'
  ) THEN
    ALTER TABLE public.pos_returns ADD COLUMN manager_override boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'pos_returns' AND column_name = 'override_reason'
  ) THEN
    ALTER TABLE public.pos_returns ADD COLUMN override_reason text DEFAULT NULL;
  END IF;
END $$;

-- 2. Drop legacy 6-argument version
DROP FUNCTION IF EXISTS public.create_pos_return_atomic(uuid, uuid, uuid, jsonb, text, text);

-- 3. Stored procedure with 8 arguments including drawer cash safety and manager override
CREATE OR REPLACE FUNCTION public.create_pos_return_atomic(
  p_store_id uuid,
  p_order_id uuid,
  p_user_id uuid,
  p_items jsonb,
  p_refund_method text DEFAULT 'cash',
  p_reason text DEFAULT '',
  p_allow_negative_cash boolean DEFAULT false,
  p_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order record;
  v_item jsonb;
  v_order_item jsonb;
  v_product record;
  v_qty integer;
  v_price numeric;
  v_condition text;
  v_total_refund numeric := 0;
  v_return_id uuid;
  v_return_number text;
  v_shift record;
  v_drawer_cash numeric := 0;
  v_is_override boolean := false;
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
    v_condition := COALESCE(v_item->>'condition', 'sound');

    -- If price is missing or 0, look it up in original order items
    IF (v_price <= 0 OR v_price IS NULL) AND v_order.items IS NOT NULL THEN
      FOR v_order_item IN SELECT * FROM jsonb_array_elements(v_order.items)
      LOOP
        IF (v_order_item->>'id' = v_item->>'id' OR v_order_item->>'product_id' = v_item->>'id' OR v_order_item->>'id' = v_item->>'product_id') THEN
          v_price := COALESCE((v_order_item->>'price')::numeric, (v_order_item->>'unit_price')::numeric, 0);
          EXIT;
        END IF;
      END LOOP;
    END IF;

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

  -- Generate return number (e.g. RET-1001-1)
  v_return_number := 'RET-' || v_order.order_number || '-' || TO_CHAR(now(), 'HH24MI');

  -- 3. If cash refund and an active shift is open, lock shift and strictly verify drawer cash safety!
  IF p_refund_method = 'cash' THEN
    SELECT id, opening_cash, cash_sales, cash_refunds, pay_ins, pay_outs, card_refunds, total_refunds
    INTO v_shift
    FROM public.pos_shifts
    WHERE store_id = p_store_id AND status = 'open'
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      -- Deterministic drawer cash available right before this refund
      v_drawer_cash := (v_shift.opening_cash + v_shift.cash_sales - v_shift.cash_refunds + v_shift.pay_ins - v_shift.pay_outs);

      -- Business Safety Decision: If cash required exceeds current drawer cash
      IF v_total_refund > v_drawer_cash THEN
        IF NOT COALESCE(p_allow_negative_cash, false) THEN
          RAISE EXCEPTION 'INSUFFICIENT_DRAWER_CASH: النقدية المتوفرة بالدرج (% ج.م) أقل من قيمة المرتجع (% ج.م). العملية مرفوضة منعاً للعجز النقدي ما لم يصرح المدير بذلك.', ROUND(v_drawer_cash, 2), ROUND(v_total_refund, 2);
        ELSE
          v_is_override := true;
        END IF;
      END IF;

      -- Increment cash_refunds (NEVER pay_outs!)
      UPDATE public.pos_shifts
      SET cash_refunds = cash_refunds + v_total_refund,
          total_refunds = total_refunds + v_total_refund,
          updated_at = now()
      WHERE id = v_shift.id;
    END IF;
  ELSIF p_refund_method = 'card' THEN
    SELECT id, total_refunds, card_refunds
    INTO v_shift
    FROM public.pos_shifts
    WHERE store_id = p_store_id AND status = 'open'
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.pos_shifts
      SET card_refunds = card_refunds + v_total_refund,
          total_refunds = total_refunds + v_total_refund,
          updated_at = now()
      WHERE id = v_shift.id;
    END IF;
  END IF;

  -- 4. Insert record into pos_returns
  INSERT INTO public.pos_returns (
    store_id, order_id, return_number, items, total_refund, refund_method, reason, cashier_user_id, manager_override, override_reason
  )
  VALUES (
    p_store_id, p_order_id, v_return_number, p_items, v_total_refund, p_refund_method, p_reason, p_user_id, v_is_override, p_override_reason
  )
  RETURNING id INTO v_return_id;

  -- 5. Record order tracking
  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (
    p_order_id,
    'refunded',
    'مرتجع كاشير بقيمة ' || v_total_refund || ' ج.م برقم ' || v_return_number || CASE WHEN v_is_override THEN ' (تصريح استثنائي للمدير)' ELSE '' END,
    p_store_id
  );

  RETURN jsonb_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'order_id', p_order_id,
    'total_refund', v_total_refund,
    'refund_method', p_refund_method,
    'items_count', jsonb_array_length(p_items),
    'manager_override', v_is_override,
    'drawer_cash_before', v_drawer_cash,
    'drawer_cash_after', (v_drawer_cash - CASE WHEN p_refund_method = 'cash' THEN v_total_refund ELSE 0 END),
    'success', true
  );
END;
$function$;
