CREATE INDEX IF NOT EXISTS phone_verification_tickets_user_id_idx
  ON public.phone_verification_tickets (user_id);

DROP INDEX IF EXISTS public.idx_domain_health_checks_domain_time;
