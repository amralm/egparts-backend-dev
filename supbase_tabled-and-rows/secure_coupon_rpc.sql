-- Fix: Server-side price & coupon validation in create_order_atomic
-- The RPC now recalculates subtotal, validates coupon, and computes total
-- Client only supplies: items (id, qty), phone, city, address, note, payment_method, coupon_code

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
  p_metadata jsonb DEFAULT '{}'::jsonb
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
BEGIN
  -- 1. Idempotency Check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id FROM public.orders WHERE idempotency_key = p_idempotency_key;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', v_order_id, 'status', 'already_exists');
    END IF;
  END IF;

  -- 2. Recalculate subtotal FROM database (ignore client-supplied prices)
  --    NOTE: We use FOR UPDATE to lock the product row, preventing TOCTOU race conditions
  --    where two concurrent orders both see sufficient stock and both deduct.
  v_subtotal := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT id, price, stock_quantity, name, is_active, COALESCE(is_deleted, false) as is_deleted INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid
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

  -- 3. Validate coupon if provided (server-side check)
  IF p_coupon_code IS NOT NULL AND p_coupon_code <> '' THEN
    SELECT id, discount_percentage, discount_amount, min_order_value, 
           max_uses, used_count, expiry_date, is_active
    INTO v_coupon
    FROM public.coupons
    WHERE code = upper(p_coupon_code);

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

    -- Ensure discount does not exceed subtotal (cannot discount shipping fees)
    IF v_discount > v_subtotal THEN
      v_discount := v_subtotal;
    END IF;

    -- Increment coupon usage atomically
    UPDATE public.coupons SET used_count = used_count + 1 WHERE id = v_coupon.id;
  END IF;

  -- 4. Generate order number
  SELECT nextval('order_number_seq') INTO v_order_number;

  -- 5. Calculate shipping fee based on city (fallback to "محافظة أخرى" if not found)
  SELECT shipping_fee INTO v_shipping_fee
  FROM public.shipping_zones WHERE city_name = p_city;
  IF NOT FOUND THEN
    SELECT shipping_fee INTO v_shipping_fee
    FROM public.shipping_zones WHERE city_name = 'محافظة أخرى';
  END IF;
  v_shipping_fee := COALESCE(v_shipping_fee, 0);

  -- 5b. Free shipping: waive fee if subtotal >= threshold
  SELECT free_shipping_enabled, free_shipping_threshold
  INTO v_free_ship_enabled, v_free_ship_threshold
  FROM public.site_settings WHERE id = 1;
  IF v_free_ship_threshold IS NOT NULL AND COALESCE(v_free_ship_enabled, true) AND v_subtotal >= v_free_ship_threshold THEN
    v_shipping_fee := 0;
  END IF;

  -- 6. Calculate total
  v_total := v_subtotal + v_shipping_fee - v_discount;
  IF v_total < 0 THEN
    v_total := 0;
  END IF;

  -- 6. Insert Order
  INSERT INTO public.orders (
    user_id, phone, city, address, customer_note,
    payment_method, subtotal, discount, shipping_fee, total,
    coupon_id, idempotency_key, order_number, status, payment_status,
    auth_source, metadata, items
  )
  VALUES (
    p_user_id, p_phone, p_city, p_address, p_customer_note,
    p_payment_method, v_subtotal, v_discount, v_shipping_fee, v_total,
    v_coupon_id, p_idempotency_key, v_order_number, 'pending', 'unpaid',
    p_auth_source, p_metadata, p_items
  )
  RETURNING id INTO v_order_id;

  -- 8. Deduct stock & insert order_items (use DB price, not client price)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT price, name INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid;

    UPDATE public.products
    SET stock_quantity = stock_quantity - (v_item->>'qty')::int
    WHERE id = (v_item->>'id')::uuid
      AND stock_quantity >= (v_item->>'qty')::int;

    INSERT INTO public.order_items (order_id, product_id, title, quantity, unit_price)
    VALUES (v_order_id, (v_item->>'id')::uuid, v_product.name, (v_item->>'qty')::int, v_product.price);
  END LOOP;

  RETURN jsonb_build_object('id', v_order_id, 'order_number', v_order_number::text, 'success', true);
END;
$$;
