-- ==============================================================================
-- Migration 99: Abandoned Cart Recovery (Zero-Risk & Anti-Ban Architecture)
-- ==============================================================================

BEGIN;

-- 1. Create cart_sessions table
CREATE TABLE IF NOT EXISTS public.cart_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  customer_name TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  recovery_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'abandoned', 'recovered', 'expired')),
  reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_sent_at TIMESTAMPTZ,
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Performance & Deduplication Indexes
-- Prevent duplicate active/abandoned carts for same store & phone
CREATE UNIQUE INDEX IF NOT EXISTS cart_sessions_store_phone_active_idx 
  ON public.cart_sessions (store_id, phone) 
  WHERE status IN ('active', 'abandoned');

-- Foreign key & Worker polling indexes
CREATE INDEX IF NOT EXISTS idx_cart_sessions_store_id 
  ON public.cart_sessions (store_id);

CREATE INDEX IF NOT EXISTS cart_sessions_worker_idx 
  ON public.cart_sessions (store_id, status, reminder_sent, last_interaction_at);

CREATE INDEX IF NOT EXISTS idx_cart_sessions_token 
  ON public.cart_sessions (recovery_token);

-- 3. Add Abandoned Cart controls to site_settings
ALTER TABLE public.site_settings 
  ADD COLUMN IF NOT EXISTS abandoned_cart_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS abandoned_cart_template TEXT NOT NULL DEFAULT 'friendly_discount',
  ADD COLUMN IF NOT EXISTS abandoned_cart_delay_minutes INTEGER NOT NULL DEFAULT 30;

-- 4. Enable RLS
ALTER TABLE public.cart_sessions ENABLE ROW LEVEL SECURITY;

-- Store managers/staff policy (handles private or public schema dynamically)
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
    WHERE tablename = 'cart_sessions' AND policyname = 'Store staff can view their store cart sessions'
  ) THEN
    EXECUTE format('CREATE POLICY "Store staff can view their store cart sessions" ON public.cart_sessions FOR SELECT TO authenticated USING (store_id IN (SELECT %s))', v_fn);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'cart_sessions' AND policyname = 'Deny anonymous direct write to cart_sessions'
  ) THEN
    CREATE POLICY "Deny anonymous direct write to cart_sessions"
      ON public.cart_sessions
      FOR ALL
      TO anon
      USING (false);
  END IF;
END $$;

COMMIT;
