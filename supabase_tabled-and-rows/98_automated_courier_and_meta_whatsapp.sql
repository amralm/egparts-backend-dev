-- Migration 98: Automated Courier Shipping Integration & Meta WhatsApp Cloud API
-- Applied to both Dev (ubkjyktgbxvzyuraapfl) and Prod (pfubitpzrmgrnzalcsgr)

CREATE TABLE IF NOT EXISTS public.store_courier_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  provider text NOT NULL,
  api_key text,
  is_active boolean DEFAULT false,
  is_test_mode boolean DEFAULT true,
  pickup_address jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_store_courier_provider UNIQUE (store_id, provider)
);

-- Safe nullable courier columns on orders
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_name text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_order_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_status text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS awb_url text;

-- Meta WhatsApp Cloud API settings in site_settings
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS whatsapp_provider text DEFAULT 'pool';
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS meta_phone_number_id text;
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS meta_access_token text;
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS meta_verify_token text;
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS meta_app_secret text;
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS meta_waba_id text;

-- RLS
ALTER TABLE public.store_courier_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS store_courier_settings_isolation ON public.store_courier_settings;
CREATE POLICY store_courier_settings_isolation ON public.store_courier_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);
