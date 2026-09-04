-- Migration 97: Store POS Cashiers Table & Manager Terminal PIN
-- Enables store cashier operator profiles, hashed PIN verification, and terminal kiosk lock

-- 1. Add pos_manager_pin_hash to stores
ALTER TABLE public.stores
ADD COLUMN IF NOT EXISTS pos_manager_pin_hash text;

-- 2. Create pos_cashiers table
CREATE TABLE IF NOT EXISTS public.pos_cashiers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  role text NOT NULL DEFAULT 'cashier' CHECK (role IN ('cashier', 'supervisor', 'manager')),
  pin_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_pos_cashiers_store_pin UNIQUE (store_id, pin_hash)
);

-- 3. Indexes for fast lookup by store and status
CREATE INDEX IF NOT EXISTS idx_pos_cashiers_store ON public.pos_cashiers(store_id);
CREATE INDEX IF NOT EXISTS idx_pos_cashiers_store_active ON public.pos_cashiers(store_id, is_active);

-- 4. Enable RLS
ALTER TABLE public.pos_cashiers ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policy: Admins can manage their store's cashiers
DROP POLICY IF EXISTS pos_cashiers_store_isolation ON public.pos_cashiers;
CREATE POLICY pos_cashiers_store_isolation ON public.pos_cashiers
  FOR ALL
  USING (
    store_id IN (SELECT get_my_stores())
  )
  WITH CHECK (
    store_id IN (SELECT get_my_stores())
  );
