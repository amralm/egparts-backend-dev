-- =====================================================================
-- Payment & Contact Numbers — Admin-configurable
-- Adds dedicated columns to site_settings so the store owner can manage
-- these numbers from the Admin Panel without touching code:
--   1. vodafone_cash_number      -> the number customers transfer to
--   2. payment_screenshot_number -> the WhatsApp number that receives
--                                   the transfer screenshot
--   3. order_confirmation_number -> the WhatsApp number used for order
--                                   confirmation (separate from the
--                                   generic whatsapp_number used for
--                                   support). Defaults to whatsapp_number.
-- =====================================================================

-- 1. Vodafone Cash number (where the customer sends the money)
ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS vodafone_cash_number text;

-- 2. Payment screenshot submission number (WhatsApp that receives the proof)
ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS payment_screenshot_number text;

-- 3. Order confirmation number (WhatsApp for confirming the order)
ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS order_confirmation_number text;

-- ---------------------------------------------------------------------
-- Seed the new columns for the existing settings row (id = 1) so the
-- app has sensible values immediately. order_confirmation_number
-- inherits the current whatsapp_number; the other two are seeded from
-- the previously hard-coded values so nothing changes until the admin
-- edits them.
-- ---------------------------------------------------------------------
UPDATE public.site_settings
SET
  vodafone_cash_number      = COALESCE(vodafone_cash_number, '01011192994'),
  payment_screenshot_number = COALESCE(payment_screenshot_number, whatsapp_number, '201122551272'),
  order_confirmation_number = COALESCE(order_confirmation_number, whatsapp_number, '201122551272')
WHERE id = 1;
