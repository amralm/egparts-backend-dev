-- The order route calls this SECURITY DEFINER function with the backend
-- service-role client. It must not be callable directly through PostgREST by
-- anonymous or browser-authenticated clients.
REVOKE EXECUTE ON FUNCTION public.create_order_atomic(
  uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated;
