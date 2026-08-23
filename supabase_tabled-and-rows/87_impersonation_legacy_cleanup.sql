-- Cleanup phase for the canonical impersonation contract.
-- Apply only after the backend containing migration 86 is live and the
-- production smoke test confirms the new REST flow.

UPDATE public.impersonation_sessions
   SET is_active = false,
       revoked_at = COALESCE(revoked_at, now())
 WHERE token_hash IS NULL
    OR store_id IS NULL
    OR admin_id IS NULL
    OR absolute_expires_at IS NULL;

UPDATE public.impersonation_sessions
   SET absolute_expires_at = expires_at,
       is_active = COALESCE(is_active, false)
 WHERE absolute_expires_at IS NULL OR is_active IS NULL;

ALTER TABLE public.impersonation_sessions
  DROP COLUMN IF EXISTS session_token,
  ALTER COLUMN absolute_expires_at SET NOT NULL,
  ALTER COLUMN is_active SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.impersonation_sessions WHERE store_id IS NULL)
     THEN ALTER TABLE public.impersonation_sessions ALTER COLUMN store_id SET NOT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.impersonation_sessions WHERE admin_id IS NULL)
     THEN ALTER TABLE public.impersonation_sessions ALTER COLUMN admin_id SET NOT NULL; END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.start_impersonation(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stop_impersonation(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.impersonation_sessions IS
  'Canonical platform-admin impersonation sessions; hash-only credentials.';
