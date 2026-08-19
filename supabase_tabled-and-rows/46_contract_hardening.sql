-- Contract hardening for privileged checkout functions and pooled WhatsApp data.
-- Keep the execution path deterministic when SECURITY DEFINER functions access tables.

ALTER FUNCTION public.process_secure_checkout(
  uuid, jsonb, text, text, text, text,
  numeric, numeric, numeric, numeric, uuid, text
) SET search_path = public;

ALTER FUNCTION public.place_order_atomic(
  uuid, jsonb, text, text, text, text, text,
  numeric, numeric, numeric, numeric, bigint
) SET search_path = public;

ALTER FUNCTION public.place_order_atomic_v3(
  uuid, jsonb, text, text, text, text, text,
  numeric, numeric, numeric, numeric, bigint, text
) SET search_path = public;

-- All pooled WhatsApp access is server-side through the service role. An explicit
-- service_role policy documents that contract without exposing the table to tenants.
ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_accounts_service_role ON public.whatsapp_accounts;
CREATE POLICY whatsapp_accounts_service_role
  ON public.whatsapp_accounts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
