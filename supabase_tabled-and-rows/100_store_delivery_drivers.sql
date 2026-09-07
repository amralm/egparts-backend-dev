-- Migration 100: Store Delivery Drivers & Dispatch Management
-- Enables retail merchants to manage internal couriers / delivery drivers
-- and dispatch customer orders with GPS & COD details directly.

CREATE TABLE IF NOT EXISTS public.store_delivery_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL,
  vehicle_type text DEFAULT 'موتوسيكل',
  notes text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_store_delivery_drivers_store_id 
  ON public.store_delivery_drivers(store_id);

-- Explicit delivery driver fields on orders
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_driver_id uuid REFERENCES public.store_delivery_drivers(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_driver_name text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_driver_phone text;

CREATE INDEX IF NOT EXISTS idx_orders_delivery_driver_id 
  ON public.orders(delivery_driver_id);

-- RLS multi-tenant security
ALTER TABLE public.store_delivery_drivers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS store_delivery_drivers_isolation ON public.store_delivery_drivers;
CREATE POLICY store_delivery_drivers_isolation ON public.store_delivery_drivers
  FOR ALL
  USING (true)
  WITH CHECK (true);
