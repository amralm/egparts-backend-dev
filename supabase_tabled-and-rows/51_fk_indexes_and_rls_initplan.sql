-- Add covering indexes for every foreign key that does not already have one.
-- The check accepts an existing index when the FK columns are its left-most
-- columns, including composite foreign keys.
DO $$
DECLARE
  fk record;
  index_name text;
  column_list text;
BEGIN
  FOR fk IN
    SELECT
      c.oid AS constraint_oid,
      n.nspname AS schema_name,
      cls.relname AS table_name,
      c.conname,
      c.conrelid,
      c.conkey
    FROM pg_constraint c
    JOIN pg_class cls ON cls.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index ix
      WHERE ix.indrelid = fk.conrelid
        AND ix.indisvalid
        AND ix.indisready
        AND ix.indnkeyatts >= cardinality(fk.conkey)
        AND (ix.indkey::int2[])[1:cardinality(fk.conkey)] = fk.conkey
    ) THEN
      SELECT string_agg(format('%I', a.attname), ', ' ORDER BY k.ordinality)
      INTO column_list
      FROM unnest(fk.conkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = k.attnum;

      index_name := left('idx_fk_' || fk.table_name || '_' || fk.conname, 55)
                    || '_' || substr(md5(fk.conname), 1, 7);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
        index_name, fk.schema_name, fk.table_name, column_list);
    END IF;
  END LOOP;
END $$;

-- Cache stable auth expressions once per statement in RLS policies. This is
-- semantics-preserving and avoids invoking auth helpers once per row.
DO $$
DECLARE
  policy_row record;
  using_expr text;
  check_expr text;
BEGIN
  FOR policy_row IN
    SELECT p.oid, p.polname, p.polrelid,
           n.nspname AS schema_name, c.relname AS table_name,
           pg_get_expr(p.polqual, p.polrelid) AS using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND (pg_get_expr(p.polqual, p.polrelid) LIKE '%auth.%()%' OR pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%auth.%()%')
  LOOP
    using_expr := policy_row.using_expr;
    check_expr := policy_row.check_expr;
    IF using_expr IS NOT NULL THEN
      using_expr := replace(using_expr, 'auth.uid()', '(select auth.uid())');
      using_expr := replace(using_expr, 'auth.jwt()', '(select auth.jwt())');
      using_expr := replace(using_expr, 'auth.role()', '(select auth.role())');
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', policy_row.polname, policy_row.schema_name, policy_row.table_name, using_expr);
    END IF;
    IF check_expr IS NOT NULL THEN
      check_expr := replace(check_expr, 'auth.uid()', '(select auth.uid())');
      check_expr := replace(check_expr, 'auth.jwt()', '(select auth.jwt())');
      check_expr := replace(check_expr, 'auth.role()', '(select auth.role())');
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', policy_row.polname, policy_row.schema_name, policy_row.table_name, check_expr);
    END IF;
  END LOOP;
END $$;
