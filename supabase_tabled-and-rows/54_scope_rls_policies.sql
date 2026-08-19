-- Policies declared for PUBLIC unintentionally apply to every database role,
-- multiplying policy evaluation and Advisor warnings. Scope them explicitly.
DO $$
DECLARE
  policy_row record;
  target_roles text;
  policy_name_lower text;
BEGIN
  FOR policy_row IN
    SELECT p.polname, c.relname AS table_name
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.polroles = ARRAY[0::oid]
  LOOP
    policy_name_lower := lower(policy_row.polname);
    IF left(policy_name_lower, 5) = 'anon_' THEN
      target_roles := 'anon';
    ELSIF policy_name_lower LIKE '%public_select%'
       OR policy_name_lower LIKE '%select_public%'
       OR policy_name_lower LIKE '%public_insert%'
       OR policy_name_lower LIKE '%insert_public%'
       OR policy_name_lower LIKE '%viewable by everyone%'
       OR policy_name_lower LIKE '%published themes%' THEN
      target_roles := 'anon, authenticated';
    ELSE
      target_roles := 'authenticated';
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I TO %s', policy_row.polname, policy_row.table_name, target_roles);
  END LOOP;
END $$;

-- Exact duplicates only; the remaining policies have different business rules.
DROP POLICY IF EXISTS banners_admin ON public.banners;
DROP POLICY IF EXISTS banners_select_public ON public.banners;
DROP POLICY IF EXISTS inventory_adjustments_admin ON public.inventory_adjustments;
DROP POLICY IF EXISTS order_logs_admin ON public.order_logs;
DROP POLICY IF EXISTS items_admin_all ON public.order_items;
DROP POLICY IF EXISTS order_items_admin_all ON public.order_items;
DROP POLICY IF EXISTS items_select_customer ON public.order_items;
DROP POLICY IF EXISTS order_items_customer_select ON public.order_items;
DROP POLICY IF EXISTS tracking_admin ON public.order_tracking;
DROP POLICY IF EXISTS tracking_select_customer ON public.order_tracking;
DROP POLICY IF EXISTS orders_customer_select ON public.orders;
DROP POLICY IF EXISTS products_select_public ON public.products;
DROP POLICY IF EXISTS views_insert_public ON public.product_views;
DROP POLICY IF EXISTS reviews_insert_public ON public.reviews;
