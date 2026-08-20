-- The failing ON CONFLICT was in notification_queue, not orders. Keep order
-- idempotency tenant-scoped and remove the temporary global index introduced
-- while isolating the production failure.
DROP INDEX IF EXISTS public.orders_idempotency_key_unique;
