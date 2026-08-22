-- 82: Tenant-bind feature reservation commit/rollback (IDOR hardening)
--
-- Why: commit_feature_usage / rollback_feature_usage previously accepted only
-- p_idempotency_key, so any caller holding a predictable key could commit or
-- roll back ANOTHER tenant's reservation via /api/storage/report-metrics
-- (cross-tenant quota manipulation). This migration adds an optional
-- p_expected_store_id argument: when provided, the RPC refuses to act on a
-- reservation row owned by a different store.
--
-- Idempotent: safe to re-run (CREATE OR REPLACE + IF EXISTS guards).
-- Applied to: Dev (pending) — apply to Production only after Dev verification.

CREATE OR REPLACE FUNCTION public.commit_feature_usage(
  p_idempotency_key text,
  p_expected_store_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.feature_reservations%ROWTYPE;
  v_allowed boolean;
BEGIN
  -- Lock the reservation row
  SELECT * INTO v_res
    FROM public.feature_reservations
   WHERE idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Tenant binding: refuse foreign reservations when the caller declares
  -- the store it is acting for.
  IF p_expected_store_id IS NOT NULL AND v_res.store_id IS DISTINCT FROM p_expected_store_id THEN
    RETURN false;
  END IF;

  -- Commit the usage permanently
  SELECT allowed INTO v_allowed
    FROM public.check_feature_limit(v_res.store_id, v_res.feature_key, v_res.amount)
   LIMIT 1;

  -- Remove the reservation
  DELETE FROM public.feature_reservations WHERE id = v_res.id;
  RETURN v_allowed;
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_feature_usage(
  p_idempotency_key text,
  p_expected_store_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feature_reservations
   WHERE idempotency_key = p_idempotency_key
     AND (p_expected_store_id IS NULL OR store_id = p_expected_store_id);
  RETURN FOUND;
END;
$$;

-- Keep EXECUTE tight: functions are invoked by the service-role backend only.
REVOKE EXECUTE ON FUNCTION public.commit_feature_usage(text, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rollback_feature_usage(text, uuid) FROM anon, authenticated;
