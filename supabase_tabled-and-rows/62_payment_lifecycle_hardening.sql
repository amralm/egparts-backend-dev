-- Payment lifecycle hardening. Apply only after 61_* migrations.
-- The RPC is the only write path for manual-wallet approval.
ALTER TABLE public.payment_outbox
  ADD COLUMN IF NOT EXISTS store_id uuid,
  ADD COLUMN IF NOT EXISTS order_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS payment_outbox_idempotency_key_uq
  ON public.payment_outbox (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE OR REPLACE FUNCTION public.approve_manual_wallet_payment(
  p_intent_id uuid,
  p_store_id uuid,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_intent public.payment_intents%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_now timestamptz := now();
  v_metadata jsonb;
BEGIN
  SELECT * INTO v_intent FROM public.payment_intents
  WHERE id = p_intent_id AND store_id = p_store_id AND provider = 'manual_wallet'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_INTENT_NOT_FOUND'; END IF;
  IF v_intent.status = 'captured' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'order_id', v_intent.order_id);
  END IF;
  IF v_intent.status <> 'waiting_verification' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_INTENT_STATUS:%', v_intent.status;
  END IF;

  SELECT * INTO v_order FROM public.orders
  WHERE id = v_intent.order_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.payment_method NOT IN ('manual_wallet') THEN RAISE EXCEPTION 'PAYMENT_METHOD_MISMATCH'; END IF;
  IF v_order.payment_status = 'paid' THEN RAISE EXCEPTION 'ORDER_ALREADY_PAID'; END IF;

  v_metadata := COALESCE(v_intent.metadata, '{}'::jsonb) || jsonb_build_object(
    'approved_by', p_admin_id, 'approved_at', v_now,
    'proof', COALESCE(v_intent.metadata->'proof', '{}'::jsonb) || jsonb_build_object('lifecycle_status', 'verified')
  );
  UPDATE public.payment_intents SET status = 'captured', metadata = v_metadata, updated_at = v_now WHERE id = p_intent_id;
  UPDATE public.orders SET payment_status = 'paid', status = 'confirmed', paid_at = v_now, updated_at = v_now WHERE id = v_order.id;

  INSERT INTO public.payment_timelines (intent_id, event_name, description, payload)
  VALUES (p_intent_id, 'payment_captured', 'Merchant approved manual wallet payment',
    jsonb_build_object('approved_by', p_admin_id, 'approved_at', v_now));
  INSERT INTO public.payment_outbox (store_id, order_id, event_type, payload, status, idempotency_key)
  VALUES (p_store_id, v_order.id, 'payment_confirmed',
    jsonb_build_object('intent_id', p_intent_id, 'order_id', v_order.id, 'provider', 'manual_wallet', 'approved_by', p_admin_id), 'pending',
    'payment:' || p_intent_id::text || ':captured')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN jsonb_build_object('success', true, 'order_id', v_order.id, 'intent_id', p_intent_id);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_manual_wallet_payment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_manual_wallet_payment(uuid, uuid, uuid) TO service_role;

-- Keep trg_order_status_change: it records order_tracking and in-app notices.
