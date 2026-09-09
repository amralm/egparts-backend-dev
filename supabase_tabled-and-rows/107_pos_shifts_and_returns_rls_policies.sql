-- Migration 107: Add Tenant Isolation RLS Policies for pos_shifts and pos_returns
-- Ensures cashier and tenant members can query, open, and close POS shifts and returns without RLS denial

DO $$
BEGIN
  -- 1. pos_shifts table policies
  ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'pos_shifts' AND policyname = 'pos_shifts_tenant_isolation'
  ) THEN
    CREATE POLICY pos_shifts_tenant_isolation ON public.pos_shifts
      FOR ALL
      USING (store_id IN (SELECT get_my_stores()))
      WITH CHECK (store_id IN (SELECT get_my_stores()));
  END IF;

  -- 2. pos_returns table policies
  ALTER TABLE public.pos_returns ENABLE ROW LEVEL SECURITY;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'pos_returns' AND policyname = 'pos_returns_tenant_isolation'
  ) THEN
    CREATE POLICY pos_returns_tenant_isolation ON public.pos_returns
      FOR ALL
      USING (store_id IN (SELECT get_my_stores()))
      WITH CHECK (store_id IN (SELECT get_my_stores()));
  END IF;
END $$;
