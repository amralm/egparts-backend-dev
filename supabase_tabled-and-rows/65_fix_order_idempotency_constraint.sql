-- create_order_atomic uses ON CONFLICT (idempotency_key). The production
-- schema only had a composite (store_id,idempotency_key) index, so every new
-- order failed with PostgreSQL 42P10 before insertion. Keep the existing
-- tenant-scoped index and add the constraint required by the live RPC.
DROP INDEX IF EXISTS public.orders_idempotency_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_unique
  ON public.orders (idempotency_key);
