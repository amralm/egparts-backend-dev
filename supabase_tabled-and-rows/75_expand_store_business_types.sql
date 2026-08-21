-- Keep the store specialization contract aligned with the tenant settings UI.
-- Existing values remain valid; this only expands the allowed enum-like set.
ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_business_type_check;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_business_type_check
  CHECK (business_type IN (
    'general',
    'automotive',
    'fashion',
    'electronics',
    'grocery',
    'health',
    'bookstore',
    'juice_bar',
    'restaurant',
    'bakery',
    'pharmacy',
    'services'
  ));
