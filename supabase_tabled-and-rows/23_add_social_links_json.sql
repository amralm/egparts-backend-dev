-- Add social_links JSONB column to site_settings table if it doesn't exist
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '[]'::jsonb;
