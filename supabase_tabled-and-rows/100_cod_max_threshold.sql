-- Migration 100: Add COD Maximum Order Threshold for Supermarkets & Merchants
ALTER TABLE public.site_settings 
  ADD COLUMN IF NOT EXISTS cod_max_threshold_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS cod_max_threshold numeric DEFAULT 1000;
