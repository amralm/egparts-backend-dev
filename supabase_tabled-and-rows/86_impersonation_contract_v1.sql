-- Canonical, tenant-scoped platform impersonation contract.
-- This migration is intentionally additive: legacy columns remain until the
-- parity audit proves that no legacy reader is still active.

DO $$
BEGIN
  IF to_regclass('public.impersonation_sessions') IS NULL THEN
    CREATE TABLE public.impersonation_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
      admin_id uuid NOT NULL,
      reason text NOT NULL,
      token_hash text,
      expires_at timestamptz NOT NULL,
      absolute_expires_at timestamptz NOT NULL,
      last_used_at timestamptz,
      revoked_at timestamptz,
      ended_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      ip_address inet,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  ELSE
    ALTER TABLE public.impersonation_sessions
      ADD COLUMN IF NOT EXISTS token_hash text,
      ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
      ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

    -- Existing raw session credentials are not part of the canonical
    -- contract. Revoking rows that cannot be mapped to the new hash-based
    -- contract makes the transition fail closed before the raw column is
    -- removed.
    UPDATE public.impersonation_sessions
       SET is_active = false,
           revoked_at = COALESCE(revoked_at, now())
     WHERE token_hash IS NULL
        OR store_id IS NULL
        OR admin_id IS NULL;
    ALTER TABLE public.impersonation_sessions DROP COLUMN IF EXISTS session_token;
  END IF;
END $$;

-- Existing rows are normalized before the canonical invariants are enforced.
-- Rows without an owning administrator were revoked above and cannot become
-- active again; valid legacy rows inherit their existing expiry as the
-- absolute boundary.
UPDATE public.impersonation_sessions
   SET absolute_expires_at = COALESCE(absolute_expires_at, expires_at),
       is_active = COALESCE(is_active, false)
 WHERE absolute_expires_at IS NULL OR is_active IS NULL;

ALTER TABLE public.impersonation_sessions
  ALTER COLUMN absolute_expires_at SET NOT NULL,
  ALTER COLUMN is_active SET NOT NULL;

-- Do not make a legacy nullable owner column fail the whole migration. New
-- rows are always written with both owners; once legacy null rows are
-- retired, the parity gate can promote these columns to NOT NULL safely.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.impersonation_sessions WHERE store_id IS NULL)
     THEN ALTER TABLE public.impersonation_sessions ALTER COLUMN store_id SET NOT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.impersonation_sessions WHERE admin_id IS NULL)
     THEN ALTER TABLE public.impersonation_sessions ALTER COLUMN admin_id SET NOT NULL; END IF;
END $$;

ALTER TABLE public.impersonation_sessions
  ALTER COLUMN is_active SET DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS impersonation_sessions_token_hash_uidx
  ON public.impersonation_sessions(token_hash)
  WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS impersonation_sessions_active_lookup_idx
  ON public.impersonation_sessions(admin_id, expires_at, revoked_at)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.impersonation_handoff_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.impersonation_sessions(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS impersonation_handoff_codes_active_idx
  ON public.impersonation_handoff_codes(code_hash, expires_at)
  WHERE used_at IS NULL;

ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_handoff_codes ENABLE ROW LEVEL SECURITY;

-- Keep the table service-role-only while making the deny-by-default policy
-- explicit for Supabase Advisor and future maintainers.
DROP POLICY IF EXISTS impersonation_handoff_codes_deny_browser ON public.impersonation_handoff_codes;
CREATE POLICY impersonation_handoff_codes_deny_browser
  ON public.impersonation_handoff_codes
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Browser roles must never read, truncate, or mutate impersonation state.
REVOKE ALL ON public.impersonation_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.impersonation_handoff_codes FROM PUBLIC, anon, authenticated;

-- Retire the database-era impersonation API. The REST contract above is the
-- only runtime entry point; leaving these SECURITY DEFINER RPCs executable
-- would preserve a second authorization model.
REVOKE EXECUTE ON FUNCTION public.start_impersonation(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stop_impersonation(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.impersonation_sessions IS
  'Canonical platform-admin impersonation sessions; token_hash only, tenant scoped.';
COMMENT ON TABLE public.impersonation_handoff_codes IS
  'Single-use short-lived handoff codes; never stores a bearer token.';
