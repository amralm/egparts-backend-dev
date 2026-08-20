-- queue_order_whatsapp_notification uses ON CONFLICT (idempotency_key).
-- A partial unique index cannot be inferred by that statement; NULL values
-- are already allowed multiple times by a normal unique index.
DROP INDEX IF EXISTS public.notification_queue_idempotency_key_unique;
CREATE UNIQUE INDEX notification_queue_idempotency_key_unique
  ON public.notification_queue (idempotency_key);
