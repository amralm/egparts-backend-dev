-- ==============================================================================
-- Migration 100: Abandoned Cart Permanent Opt-Out System
-- ==============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.cart_opt_outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
  reason TEXT DEFAULT 'customer_requested_stop',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cart_opt_outs_phone_store_idx 
  ON public.cart_opt_outs (phone, store_id);

CREATE INDEX IF NOT EXISTS idx_cart_opt_outs_phone 
  ON public.cart_opt_outs (phone);

ALTER TABLE public.cart_opt_outs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_fn text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema = 'private' AND routine_name = 'get_my_stores') THEN
    v_fn := 'private.get_my_stores()';
  ELSE
    v_fn := 'public.get_my_stores()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'cart_opt_outs' AND policyname = 'Store staff can view their store opt-outs'
  ) THEN
    EXECUTE format('CREATE POLICY "Store staff can view their store opt-outs" ON public.cart_opt_outs FOR SELECT TO authenticated USING (store_id IN (SELECT %s))', v_fn);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'cart_opt_outs' AND policyname = 'Deny anonymous direct write to cart_opt_outs'
  ) THEN
    CREATE POLICY "Deny anonymous direct write to cart_opt_outs"
      ON public.cart_opt_outs
      FOR ALL
      TO anon
      USING (false);
  END IF;
END $$;

COMMIT;
