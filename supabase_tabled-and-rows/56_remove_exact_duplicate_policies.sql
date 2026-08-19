-- Remove only byte-for-byte equivalent policies. Different predicates remain
-- separate because they represent different authorization paths.
DO $$
DECLARE
  duplicate_group record;
  policy_index integer;
BEGIN
  FOR duplicate_group IN
    SELECT
      p.polrelid,
      c.relname AS table_name,
      p.polroles,
      p.polcmd,
      pg_get_expr(p.polqual, p.polrelid) AS qual_expr,
      pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr,
      array_agg(p.polname ORDER BY p.oid) AS policy_names
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    GROUP BY p.polrelid, c.relname, p.polroles, p.polcmd,
             pg_get_expr(p.polqual, p.polrelid),
             pg_get_expr(p.polwithcheck, p.polrelid)
    HAVING count(*) > 1
  LOOP
    FOR policy_index IN 2..array_length(duplicate_group.policy_names, 1) LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', duplicate_group.policy_names[policy_index], duplicate_group.table_name);
    END LOOP;
  END LOOP;
END $$;
