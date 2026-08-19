-- WhatsApp pool, cost snapshots, and the canonical feature contract.
-- Safe to run repeatedly; existing data is preserved.

CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'pending',
  priority integer NOT NULL DEFAULT 100,
  weight integer NOT NULL DEFAULT 1,
  max_concurrency integer NOT NULL DEFAULT 1,
  active_jobs integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  circuit_state text NOT NULL DEFAULT 'closed',
  circuit_opened_at timestamptz,
  last_connected_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone_number)
);

ALTER TABLE public.whatsapp_sessions
  ADD COLUMN IF NOT EXISTS whatsapp_account_id uuid REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE;

ALTER TABLE public.notification_queue
  ADD COLUMN IF NOT EXISTS whatsapp_account_id uuid REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS notification_queue_idempotency_key_unique
  ON public.notification_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS unit_cost_snapshot numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_profit numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.populate_order_item_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost numeric;
BEGIN
  SELECT COALESCE(cost_price, 0) INTO v_cost
  FROM public.products
  WHERE id = NEW.product_id;

  IF NEW.unit_cost_snapshot IS NULL OR NEW.unit_cost_snapshot = 0 THEN
    NEW.unit_cost_snapshot := COALESCE(v_cost, 0);
  END IF;
  NEW.gross_profit := (COALESCE(NEW.unit_price, 0) - COALESCE(NEW.unit_cost_snapshot, 0)) * COALESCE(NEW.quantity, 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_cost_snapshot_trigger ON public.order_items;
CREATE TRIGGER order_items_cost_snapshot_trigger
BEFORE INSERT ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.populate_order_item_cost_snapshot();

UPDATE public.order_items oi
SET unit_cost_snapshot = COALESCE(p.cost_price, 0),
    gross_profit = (COALESCE(oi.unit_price, 0) - COALESCE(p.cost_price, 0)) * COALESCE(oi.quantity, 0)
FROM public.products p
WHERE p.id = oi.product_id
  AND (oi.unit_cost_snapshot = 0 OR oi.gross_profit = 0);

REVOKE ALL ON FUNCTION public.populate_order_item_cost_snapshot() FROM PUBLIC;

CREATE INDEX IF NOT EXISTS whatsapp_accounts_pool_idx
  ON public.whatsapp_accounts (enabled, status, circuit_state, priority, active_jobs);
CREATE INDEX IF NOT EXISTS whatsapp_sessions_account_idx
  ON public.whatsapp_sessions (whatsapp_account_id);
CREATE INDEX IF NOT EXISTS notification_queue_dispatch_idx
  ON public.notification_queue (status, next_retry_at, type, whatsapp_account_id);
CREATE INDEX IF NOT EXISTS order_items_store_idx
  ON public.order_items (store_id, created_at);

INSERT INTO public.features (key, display_name, description)
VALUES
  ('whatsapp_enabled', 'WhatsApp enabled', 'Allow WhatsApp messaging'),
  ('whatsapp_accounts_max', 'Maximum WhatsApp accounts', 'Maximum accounts in the central pool'),
  ('whatsapp_messages_month', 'WhatsApp messages per month', 'Monthly WhatsApp message quota'),
  ('whatsapp_concurrency', 'WhatsApp concurrency', 'Maximum concurrent WhatsApp jobs')
ON CONFLICT (key) DO NOTHING;

-- Make the new capabilities visible to every existing plan. Limits remain
-- explicit and are configured by the platform administrator.
INSERT INTO public.plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM public.plans p
JOIN public.features f ON f.key IN (
  'whatsapp_enabled', 'whatsapp_accounts_max',
  'whatsapp_messages_month', 'whatsapp_concurrency'
)
ON CONFLICT (plan_id, feature_id) DO NOTHING;

-- Canonical semantics: 0 disables a feature, -1 is unlimited, positive values
-- are hard limits. Missing plan/limit is denied for metered operations.
CREATE OR REPLACE FUNCTION public.resolve_feature_limit(
  p_store_id uuid,
  p_feature_key text
)
RETURNS TABLE (
  has_plan boolean,
  has_limit boolean,
  limit_type text,
  limit_config jsonb,
  period_type text,
  plan_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sub.plan_id IS NOT NULL,
    fl.id IS NOT NULL,
    fl.limit_type,
    fl.limit_config,
    COALESCE(fl.limit_config->>'period_type', fl.limit_config->>'period', public.infer_feature_period_type(lower(p_feature_key))),
    sub.plan_id
  FROM (SELECT 1) seed
  LEFT JOIN LATERAL (
    SELECT ss.plan_id
    FROM public.store_subscriptions ss
    WHERE ss.store_id = p_store_id
    ORDER BY (ss.status = 'active') DESC, ss.created_at DESC
    LIMIT 1
  ) sub ON true
  LEFT JOIN public.features f ON f.key = lower(p_feature_key)
  LEFT JOIN public.plan_features pf ON pf.plan_id = sub.plan_id AND pf.feature_id = f.id
  LEFT JOIN LATERAL (
    SELECT fl2.* FROM public.feature_limits fl2
    WHERE fl2.plan_feature_id = pf.id
    ORDER BY fl2.updated_at DESC
    LIMIT 1
  ) fl ON true;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_feature_limit(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_feature_limit(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_feature_limit(uuid, text) TO service_role;
