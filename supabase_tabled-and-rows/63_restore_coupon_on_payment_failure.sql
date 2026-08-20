-- Release one reservation atomically for unpaid orders. The marker prevents
-- duplicate webhook/rejection/expiry paths from restoring stock or coupons twice.
CREATE OR REPLACE FUNCTION public.restore_order_stock(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o public.orders%ROWTYPE; item jsonb; pid uuid; qty integer; restored integer := 0; coupon_restored boolean := false;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF COALESCE(o.payment_details->>'stock_restored_at', '') <> '' THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'already_restored');
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) LOOP
    pid := NULLIF(COALESCE(item->>'id', item->>'product_id'), '')::uuid;
    qty := GREATEST(COALESCE((item->>'qty')::integer, (item->>'quantity')::integer, 0), 0);
    IF pid IS NOT NULL AND qty > 0 THEN
      UPDATE public.products SET stock_quantity = COALESCE(stock_quantity, 0) + qty, updated_at = now()
      WHERE id = pid AND store_id = o.store_id;
      restored := restored + qty;
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
REVOKE ALL ON FUNCTION public.restore_order_stock(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_order_stock(uuid) TO service_role;
