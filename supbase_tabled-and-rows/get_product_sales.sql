-- Fix: get_product_sales_today now reads from order_items table
-- (which has proper product_id UUID column) instead of parsing JSONB
-- from orders.items. The create_order_atomic RPC stores items in both
-- order_items table AND the items JSONB, but order_items is the reliable source.

CREATE OR REPLACE FUNCTION get_product_sales_today(p_product_id UUID)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_sold integer := 0;
BEGIN
  SELECT COALESCE(SUM(oi.quantity), 0)
  INTO v_total_sold
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.product_id = p_product_id
    AND o.created_at >= now() - interval '24 hours'
    AND o.status NOT IN ('cancelled');

  RETURN v_total_sold;
END;
$$;
