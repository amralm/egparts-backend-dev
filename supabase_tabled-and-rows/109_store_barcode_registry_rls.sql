-- Migration 109: RLS policy for store_barcode_registry
-- Ensures complete policy coverage for all public tables with rowsecurity = true

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'store_barcode_registry' AND policyname = 'store_barcode_registry_tenant_isolation'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'private') THEN
      CREATE POLICY "store_barcode_registry_tenant_isolation" ON store_barcode_registry
        FOR ALL
        USING (store_id IN (SELECT private.get_my_stores()));
    ELSE
      CREATE POLICY "store_barcode_registry_tenant_isolation" ON store_barcode_registry
        FOR ALL
        USING (store_id IN (SELECT get_my_stores()));
    END IF;
  END IF;
END $$;
