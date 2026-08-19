CREATE OR REPLACE FUNCTION public.restore_order_stock(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  locked_order public.orders%ROWTYPE;
  item jsonb;
  product_id uuid;
  quantity integer;
  restored integer := 0;
BEGIN
  SELECT * INTO locked_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF COALESCE(locked_order.payment_details->>'stock_restored_at', '') <> '' THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'already_restored');
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(locked_order.items, '[]'::jsonb)) LOOP
    product_id := NULLIF(COALESCE(item->>'id', item->>'product_id'), '')::uuid;
    quantity := GREATEST(COALESCE((item->>'qty')::integer, (item->>'quantity')::integer, 0), 0);
    IF product_id IS NOT NULL AND quantity > 0 THEN
      UPDATE public.products
      SET stock_quantity = COALESCE(stock_quantity, 0) + quantity,
          updated_at = now()
      WHERE id = product_id AND store_id = locked_order.store_id;
      restored := restored + quantity;
    END IF;
  END LOOP;

  UPDATE public.orders
  SET payment_details = COALESCE(payment_details, '{}'::jsonb) || jsonb_build_object(
    'stock_restored_at', now(),
    'stock_restored_quantity', restored
  ), updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('restored', true, 'quantity', restored);
END;
$$;

REVOKE ALL ON FUNCTION public.restore_order_stock(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_order_stock(uuid) TO service_role;
