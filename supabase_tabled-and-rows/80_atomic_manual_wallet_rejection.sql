-- Make manual-wallet rejection atomic, idempotent, and tenant-scoped.
CREATE OR REPLACE FUNCTION public.reject_manual_wallet_payment(
  p_intent_id uuid,
  p_store_id uuid,
  p_admin_id uuid,
  p_reason text DEFAULT NULL
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
  v_reason text := COALESCE(NULLIF(trim(p_reason), ''), 'Merchant rejected payment receipt');
  v_metadata jsonb;
  v_restore jsonb;
BEGIN
  SELECT * INTO v_intent
  FROM public.payment_intents
  WHERE id = p_intent_id AND store_id = p_store_id AND provider = 'manual_wallet'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_INTENT_NOT_FOUND'; END IF;
  IF v_intent.status = 'failed' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'order_id', v_intent.order_id);
  END IF;
  IF v_intent.status <> 'waiting_verification' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_INTENT_STATUS:%', v_intent.status;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = v_intent.order_id AND store_id = p_store_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  v_metadata := COALESCE(v_intent.metadata, '{}'::jsonb) || jsonb_build_object(
    'rejected_by', p_admin_id,
    'rejected_at', v_now,
    'rejection_reason', v_reason,
    'proof', COALESCE(v_intent.metadata->'proof', '{}'::jsonb) || jsonb_build_object('lifecycle_status', 'rejected')
  );
  UPDATE public.payment_intents
  SET status = 'failed', metadata = v_metadata, updated_at = v_now
  WHERE id = p_intent_id;
  UPDATE public.orders
  SET payment_status = 'failed', updated_at = v_now
  WHERE id = v_order.id;

  v_restore := public.restore_order_stock(v_order.id);

  INSERT INTO public.payment_timelines (intent_id, event_name, description, payload)
  VALUES (p_intent_id, 'payment_failed', v_reason,
    jsonb_build_object('rejected_by', p_admin_id, 'rejected_at', v_now));
  INSERT INTO public.payment_outbox (store_id, order_id, event_type, payload, status, idempotency_key)
  VALUES (p_store_id, v_order.id, 'payment_failed',
    jsonb_build_object('intent_id', p_intent_id, 'order_id', v_order.id, 'provider', 'manual_wallet', 'reason', v_reason),
    'pending', 'payment:' || p_intent_id::text || ':failed')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'order_id', v_order.id, 'intent_id', p_intent_id, 'restore', v_restore);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_manual_wallet_payment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_manual_wallet_payment(uuid, uuid, uuid, text) TO service_role;
