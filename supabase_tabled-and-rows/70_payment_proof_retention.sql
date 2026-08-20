-- Durable payment-proof retention queue.
-- The web service is not the scheduler: an external Render Cron Job runs the
-- worker, while this table keeps the deadline and retry state in Supabase.

CREATE TABLE IF NOT EXISTS public.payment_proof_retention (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL UNIQUE REFERENCES public.payment_intents(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  r2_key text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deletion_pending', 'deleted', 'deletion_failed')),
  retention_source text NOT NULL DEFAULT 'platform_default'
    CHECK (retention_source IN ('platform_default', 'store_override', 'immediate_rejected')),
  quota_feature_key text NOT NULL DEFAULT 'uploaded_images',
  quota_bytes bigint NOT NULL DEFAULT 0 CHECK (quota_bytes >= 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deletion_started_at timestamptz,
  deleted_at timestamptz,
  quota_released_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_proof_retention_due
  ON public.payment_proof_retention (status, expires_at)
  WHERE status IN ('active', 'deletion_pending', 'deletion_failed');

CREATE INDEX IF NOT EXISTS idx_payment_proof_retention_store
  ON public.payment_proof_retention (store_id, status, expires_at);

ALTER TABLE public.payment_proof_retention ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_proof_retention_no_client_access ON public.payment_proof_retention;
CREATE POLICY payment_proof_retention_no_client_access
  ON public.payment_proof_retention
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.payment_proof_retention FROM anon, authenticated;

COMMENT ON TABLE public.payment_proof_retention IS
  'Durable, service-role-only queue for deleting private payment proof objects from R2.';

-- Global default. Store-level site_settings.proof_retention_days remains the
-- explicit override for stores that need a different retention period.
INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('payment_proof_retention_default_days', '30', now())
ON CONFLICT (key) DO NOTHING;

-- Release the exact quota charged for this proof at most once. This closes the
-- crash window between deleting R2 and updating the retention row.
CREATE OR REPLACE FUNCTION public.release_payment_proof_quota(p_intent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_retention public.payment_proof_retention%ROWTYPE;
  v_usage_id uuid;
  v_storage_usage_id uuid;
BEGIN
  SELECT * INTO v_retention
  FROM public.payment_proof_retention
  WHERE intent_id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'retention_not_found');
  END IF;

  IF v_retention.quota_released_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_released');
  END IF;

  SELECT id INTO v_usage_id
  FROM public.feature_usage
  WHERE store_id = v_retention.store_id
    AND feature_key = v_retention.quota_feature_key
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_usage_id IS NOT NULL THEN
    UPDATE public.feature_usage
    SET usage_count = GREATEST(0, usage_count - 1), updated_at = now()
    WHERE id = v_usage_id;
  END IF;

  SELECT id INTO v_storage_usage_id
  FROM public.feature_usage
  WHERE store_id = v_retention.store_id
    AND feature_key = 'storage_bytes'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_storage_usage_id IS NOT NULL AND v_retention.quota_bytes > 0 THEN
    UPDATE public.feature_usage
    SET usage_count = GREATEST(0, usage_count - v_retention.quota_bytes), updated_at = now()
    WHERE id = v_storage_usage_id;
  END IF;

  UPDATE public.payment_proof_retention
  SET quota_released_at = now(), updated_at = now()
  WHERE id = v_retention.id;

  RETURN jsonb_build_object('released', true);
END;
$$;

REVOKE ALL ON FUNCTION public.release_payment_proof_quota(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_proof_quota(uuid) TO service_role;
