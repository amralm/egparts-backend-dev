-- Keep the address contract compatible with map-selected checkout addresses.
-- Safe for existing rows: location_url is optional and does not alter order data.
ALTER TABLE public.user_addresses
  ADD COLUMN IF NOT EXISTS location_url text;

COMMENT ON COLUMN public.user_addresses.location_url IS
  'Optional map/geocoding URL captured with the customer address.';
