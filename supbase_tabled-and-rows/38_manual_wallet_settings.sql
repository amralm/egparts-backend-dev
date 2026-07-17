-- Migration 38: Extend site_settings for Manual Wallet feature
-- Adds columns for multi-wallet support (Vodafone, Etisalat, Orange Cash)
-- and a feature toggle for the merchant to enable/disable the feature.

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS manual_wallet_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS etisalat_cash_number TEXT,
  ADD COLUMN IF NOT EXISTS orange_cash_number TEXT,
  ADD COLUMN IF NOT EXISTS manual_wallet_instructions TEXT;

-- Also verify the payment_proofs storage bucket exists
-- (run separately in Supabase dashboard if needed)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('payment_proofs', 'payment_proofs', false)
-- ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN site_settings.manual_wallet_enabled IS 'Toggle to enable/disable manual wallet payments for this store';
COMMENT ON COLUMN site_settings.vodafone_cash_number IS 'Vodafone Cash wallet number';
COMMENT ON COLUMN site_settings.etisalat_cash_number IS 'Etisalat Cash wallet number';
COMMENT ON COLUMN site_settings.orange_cash_number IS 'Orange Cash wallet number';
COMMENT ON COLUMN site_settings.manual_wallet_instructions IS 'Custom payment transfer instructions shown to customers';
