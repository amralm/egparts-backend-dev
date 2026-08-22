-- 86: Explicit deny-all policies for every public table that has RLS enabled
-- but zero policies.
--
-- Why: RLS-on/no-policies already denies anon/authenticated by default, but the
-- Supabase advisor flags it because it is usually a misconfiguration smell and
-- it stays a latent footgun (a later broad GRANT or an accidental "fix" that
-- disables RLS would expose data). Making the deny explicit documents intent,
-- clears the advisor, and keeps service_role access untouched (bypassrls).
--
-- Verified safe before writing: frontend/src performs ZERO supabase.from()
-- and ZERO supabase.rpc() calls; every business read/write flows through the
-- backend service role.
--
-- Idempotent: re-runs only touch tables still missing a deny policy.

DO $$
DECLARE
  tbl record;
  policy_name text;
BEGIN
  FOR tbl IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
  LOOP
    policy_name := 'deny_public_api_' || tbl.table_name;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      policy_name, tbl.table_name
    );
  END LOOP;
END $$;
