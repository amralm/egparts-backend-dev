-- Security-definer functions are privileged database APIs. They must not be
-- executable by PUBLIC by default. Backend service_role remains authorized.
DO $$
DECLARE
  fn record;
  policy_helpers constant text[] := ARRAY[
    'get_my_stores', 'is_platform_owner', 'is_store_active', 'is_super_admin',
    'row_store_id_from_branch', 'row_store_id_from_product',
    'row_store_id_from_shelf', 'row_store_id_from_warehouse'
  ];
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', fn.proname, fn.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', fn.proname, fn.args);
    IF fn.proname = ANY(policy_helpers) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated', fn.proname, fn.args);
    END IF;
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
