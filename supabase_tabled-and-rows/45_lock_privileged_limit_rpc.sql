-- All tenant limit decisions are made by the backend service role. The RPC
-- accepts a store id, so it must not be callable by arbitrary authenticated
-- clients without a tenant authorization check.
REVOKE EXECUTE ON FUNCTION public.check_feature_limit(uuid, text, integer) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.check_feature_limit(uuid, text, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.resolve_feature_limit(uuid, text) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.resolve_feature_limit(uuid, text) TO service_role;
