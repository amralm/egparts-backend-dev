-- Add new columns for the Dynamic Footer and White Label settings

ALTER TABLE public.site_settings
ADD COLUMN IF NOT EXISTS store_description text,
ADD COLUMN IF NOT EXISTS copyright_text text DEFAULT 'All Rights Reserved',
ADD COLUMN IF NOT EXISTS support_hours text;

-- Provide some default values if they are null
UPDATE public.site_settings
SET store_description = 'نحن متجرك الموثوق لتوفير أفضل قطع الغيار المنزلية بجودة عالية وأسعار تنافسية.',
    copyright_text = '© 2024 EG-PARTS. جميع الحقوق محفوظة.',
    support_hours = 'يومياً من 9 صباحاً حتى 10 مساءً'
WHERE id = 1;
