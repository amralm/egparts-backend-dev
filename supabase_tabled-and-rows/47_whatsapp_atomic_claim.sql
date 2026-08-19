-- Atomic pool slot claiming. The previous read-then-write sequence could
-- oversubscribe an account when multiple jobs arrived simultaneously.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_account(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.whatsapp_accounts
  SET active_jobs = active_jobs + 1,
      updated_at = now()
  WHERE id = p_account_id
    AND enabled = true
    AND COALESCE(circuit_state, 'closed') <> 'open'
    AND active_jobs < max_concurrency;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_whatsapp_account(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.whatsapp_accounts
  SET active_jobs = GREATEST(0, active_jobs - 1),
      updated_at = now()
  WHERE id = p_account_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_whatsapp_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_account(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_account(uuid) TO service_role;
