-- Final-state hardening for every privileged function already present in the
-- database. Older migrations may have created SECURITY DEFINER functions before
-- search_path was standardized; fixing only the migration text would not fix an
-- already-provisioned production database.
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

COMMENT ON SCHEMA private IS
  'Privileged helper functions are isolated here; all SECURITY DEFINER functions use a fixed public, pg_temp search_path.';
