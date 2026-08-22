-- 83: Remove exploitable legacy quota overloads + finish search_path hardening.
--
-- Why:
-- 1) Migration 82 introduced store-bound commit/rollback_feature_usage(text, uuid).
--    The legacy single-argument overloads remained with EXECUTE granted to
--    anon/authenticated. Because they are SECURITY DEFINER they bypass RLS, so
--    the cross-tenant quota manipulation stayed reachable through them directly
--    via PostgREST. They are also now ambiguous candidates for single-arg calls
--    (the uuid parameter of the new overload defaults to NULL), which can break
--    RPC resolution for legitimate internal callers.
--    => Drop the legacy overloads. Single-key calls resolve uniquely to the new
--       overload where p_expected_store_id defaults to NULL, preserving the
--       internal service contract while removing anonymous reachability.
--
-- 2) Migration 81 hardened search_path for every SECURITY DEFINER function that
--    existed at its time, but a live audit shows functions without it remain
--    (created/replaced afterwards). Re-run the same idempotent hardening so the
--    final state is uniform.
--
-- Idempotent: safe to re-run.

DROP FUNCTION IF EXISTS public.commit_feature_usage(p_idempotency_key text);
DROP FUNCTION IF EXISTS public.rollback_feature_usage(p_idempotency_key text);

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT n.nspname AS schema_name,
           p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private')
      AND p.prosecdef
      AND (p.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS cfg(entry)
        WHERE entry LIKE 'search_path=%'
      ))
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, pg_temp',
      fn.schema_name,
      fn.function_name,
      fn.identity_arguments
    );
  END LOOP;
END
$$;

-- Keep privileged quota RPCs service-role only (defense in depth; matches 82).
REVOKE ALL ON FUNCTION public.commit_feature_usage(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rollback_feature_usage(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_feature_usage(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_feature_usage(text, uuid) TO service_role;
