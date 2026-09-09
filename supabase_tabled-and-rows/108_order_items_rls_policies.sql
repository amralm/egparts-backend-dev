-- Migration 108: RLS policies for order_items
-- Ensures store admins and customers can query order_items safely,
-- resolving missing COGS, product sales volume, and gross profit metrics.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'order_items_admin_all'
  ) THEN
    CREATE POLICY "order_items_admin_all" ON order_items
      FOR ALL
      USING (
        order_id IN (
          SELECT id FROM orders WHERE store_id IN (SELECT private.get_my_stores())
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'order_items_select_customer'
  ) THEN
    CREATE POLICY "order_items_select_customer" ON order_items
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM orders o 
          WHERE o.id = order_items.order_id 
          AND o.user_id = (SELECT auth.uid())
        )
      );
  END IF;
END $$;
