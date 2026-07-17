-- Phase 1 Migration: Add theme_id and theme_overrides to site_settings
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS theme_id text DEFAULT 'midnight';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS theme_overrides jsonb DEFAULT '{}'::jsonb;

-- Optional: Validate theme_overrides is a valid JSON object
ALTER TABLE site_settings ADD CONSTRAINT valid_theme_overrides CHECK (jsonb_typeof(theme_overrides) = 'object');

-- Note: theme_colors remains for backward compatible read in Phase 1
