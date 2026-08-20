-- Payment confirmation and Paymob callbacks persist the settlement time.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
