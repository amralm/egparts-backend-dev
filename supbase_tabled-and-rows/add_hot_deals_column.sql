-- Add hot_deals JSONB column to site_settings for managing hot deal promotions
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS hot_deals JSONB DEFAULT '{}'::jsonb;
