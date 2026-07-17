-- Add whatsapp_group_link column to site_settings table if it doesn't exist
ALTER TABLE public.site_settings ADD COLUMN IF NOT EXISTS whatsapp_group_link text;
