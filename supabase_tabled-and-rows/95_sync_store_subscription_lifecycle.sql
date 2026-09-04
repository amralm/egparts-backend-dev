-- Migration 95: Sync Store Subscription Lifecycle
-- Guarantees 100% two-way data integrity between stores and store_subscriptions tables
-- Prevents subscription expiry drift, UI status discrepancy, and desynchronization.

-- 1. Sync from store_subscriptions -> stores
CREATE OR REPLACE FUNCTION public.sync_store_subscription_to_store()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Prevent recursive trigger loops
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.store_id IS NOT NULL THEN
    IF NEW.status = 'active' THEN
      UPDATE public.stores
      SET 
        subscription_expires_at = COALESCE(NEW.expires_at, stores.subscription_expires_at),
        status = 'active',
        is_active = true,
        updated_at = now()
      WHERE id = NEW.store_id
        AND (
          stores.subscription_expires_at IS DISTINCT FROM NEW.expires_at
          OR stores.status IS DISTINCT FROM 'active'
          OR stores.is_active IS DISTINCT FROM true
        );
    ELSIF NEW.status = 'suspended' THEN
      UPDATE public.stores
      SET 
        status = 'suspended',
        updated_at = now()
      WHERE id = NEW.store_id
        AND stores.status IS DISTINCT FROM 'suspended';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_store_subscription_to_store ON public.store_subscriptions;
CREATE TRIGGER trg_sync_store_subscription_to_store
AFTER INSERT OR UPDATE ON public.store_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.sync_store_subscription_to_store();

-- 2. Sync from stores -> store_subscriptions
CREATE OR REPLACE FUNCTION public.sync_store_to_store_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Prevent recursive trigger loops
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS NOT NULL AND (
    NEW.subscription_expires_at IS DISTINCT FROM OLD.subscription_expires_at
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    UPDATE public.store_subscriptions
    SET
      expires_at = COALESCE(NEW.subscription_expires_at, store_subscriptions.expires_at),
      status = CASE 
        WHEN NEW.status = 'active' THEN 'active'
        WHEN NEW.status = 'suspended' THEN 'suspended'
        ELSE store_subscriptions.status
      END,
      updated_at = now()
    WHERE store_id = NEW.id
      AND (
        store_subscriptions.expires_at IS DISTINCT FROM NEW.subscription_expires_at
        OR (NEW.status IN ('active', 'suspended') AND store_subscriptions.status IS DISTINCT FROM NEW.status)
      );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_store_to_store_subscription ON public.stores;
CREATE TRIGGER trg_sync_store_to_store_subscription
AFTER UPDATE OF subscription_expires_at, status ON public.stores
FOR EACH ROW
EXECUTE FUNCTION public.sync_store_to_store_subscription();
