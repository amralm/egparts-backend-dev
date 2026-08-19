-- Query indexes used by tenant-scoped dashboards and retention jobs.
CREATE INDEX IF NOT EXISTS products_store_deleted_idx
  ON public.products (store_id, is_deleted);

CREATE INDEX IF NOT EXISTS domain_health_checks_domain_checked_idx
  ON public.domain_health_checks (domain_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS payment_intents_store_status_updated_idx
  ON public.payment_intents (store_id, status, updated_at DESC);
