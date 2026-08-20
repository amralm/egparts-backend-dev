-- approve_manual_wallet_payment also uses ON CONFLICT (idempotency_key).
-- Replace the partial index so PostgreSQL can infer the conflict target.
DROP INDEX IF EXISTS public.payment_outbox_idempotency_key_uq;
CREATE UNIQUE INDEX payment_outbox_idempotency_key_uq
  ON public.payment_outbox (idempotency_key);
