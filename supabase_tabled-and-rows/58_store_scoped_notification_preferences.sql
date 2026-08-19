-- Make order/payment WhatsApp controls tenant-scoped.
-- Existing global defaults are copied to every store before the old key is removed.
BEGIN;

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_store_event_uq
  ON public.notification_preferences (store_id, event_key);

INSERT INTO public.notification_preferences (store_id, event_key, display_name, whatsapp_enabled, email_enabled)
SELECT s.id, p.event_key, p.display_name, p.whatsapp_enabled, p.email_enabled
FROM public.stores s
JOIN public.notification_preferences p ON p.store_id IS NULL
ON CONFLICT (store_id, event_key) DO NOTHING;

DELETE FROM public.notification_preferences WHERE store_id IS NULL;

DO $$
DECLARE v_pk text;
BEGIN
  SELECT conname INTO v_pk
  FROM pg_constraint
  WHERE conrelid = 'public.notification_preferences'::regclass
    AND contype = 'p';
  IF v_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.notification_preferences DROP CONSTRAINT %I', v_pk);
  END IF;
END $$;

ALTER TABLE public.notification_preferences
  ALTER COLUMN store_id SET NOT NULL;

ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (store_id, event_key);

DROP INDEX IF EXISTS public.notification_preferences_store_event_uq;
DROP INDEX IF EXISTS public.notification_preferences_store_idx;

CREATE OR REPLACE FUNCTION public.queue_order_whatsapp_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone text;
  v_order_ref text;
  v_status_label text;
  v_event_key text;
  v_message text;
  v_store_name text;
BEGIN
  SELECT s.name INTO v_store_name FROM public.stores s WHERE s.id = NEW.store_id;
  v_phone := COALESCE(NULLIF(NEW.phone, ''), (
    SELECT up.phone FROM public.user_profiles up
    WHERE up.user_id = NEW.user_id AND up.store_id = NEW.store_id
    LIMIT 1
  ));
  IF NULLIF(v_phone, '') IS NULL THEN RETURN NEW; END IF;

  v_order_ref := 'EG-' || COALESCE(NEW.order_number::text, split_part(NEW.id::text, '-', 1));

  IF TG_OP = 'INSERT' THEN
    v_event_key := 'order_created';
    v_message := 'تم تسجيل طلبكم بنجاح برقم: ' || v_order_ref || chr(10) ||
      'حالة الطلب الحالية: قيد المراجعة.' || chr(10) ||
      'نشكركم لتسوقكم من ' || COALESCE(NULLIF(v_store_name, ''), 'المتجر') || '.';

    IF EXISTS (SELECT 1 FROM public.notification_preferences
      WHERE store_id = NEW.store_id AND event_key = v_event_key AND whatsapp_enabled) THEN
      INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id, idempotency_key)
      VALUES (v_phone, jsonb_build_object('message', v_message, 'event_key', v_event_key), 'whatsapp', 'pending', NEW.id, NEW.store_id,
        'order:' || NEW.id::text || ':created') ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    IF NEW.payment_status = 'paid' THEN
      v_event_key := 'payment_confirmed';
      v_message := 'تم تأكيد الدفع للطلب ' || v_order_ref || '.' || chr(10) || 'سيبدأ تجهيز طلبكم قريبًا.';
    ELSIF NEW.payment_status IN ('failed', 'cancelled', 'canceled', 'expired') THEN
      v_event_key := 'payment_failed';
      v_message := 'تعذر تأكيد الدفع للطلب ' || v_order_ref || '.' || chr(10) || 'يرجى المحاولة مرة أخرى أو التواصل مع المتجر.';
    ELSE
      v_event_key := NULL;
    END IF;

    IF v_event_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.notification_preferences
      WHERE store_id = NEW.store_id AND event_key = v_event_key AND whatsapp_enabled) THEN
      INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id, idempotency_key)
      VALUES (v_phone, jsonb_build_object('message', v_message, 'event_key', v_event_key), 'whatsapp', 'pending', NEW.id, NEW.store_id,
        'order:' || NEW.id::text || ':payment:' || NEW.payment_status) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    v_event_key := 'order_status_' || NEW.status;
    v_status_label := CASE NEW.status
      WHEN 'pending' THEN 'قيد المراجعة' WHEN 'confirmed' THEN 'تم التأكيد'
      WHEN 'processing' THEN 'جاري التجهيز' WHEN 'shipped' THEN 'تم الشحن'
      WHEN 'delivered' THEN 'تم التسليم' WHEN 'cancelled' THEN 'ملغي'
      ELSE NEW.status END;
    v_message := 'تم تحديث حالة طلبكم ' || v_order_ref || ' إلى: ' || v_status_label || '.' || chr(10) ||
      'نشكركم لاختياركم ' || COALESCE(NULLIF(v_store_name, ''), 'المتجر') || '.';

    IF EXISTS (SELECT 1 FROM public.notification_preferences
      WHERE store_id = NEW.store_id AND event_key = v_event_key AND whatsapp_enabled) THEN
      INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id, idempotency_key)
      VALUES (v_phone, jsonb_build_object('message', v_message, 'event_key', v_event_key), 'whatsapp', 'pending', NEW.id, NEW.store_id,
        'order:' || NEW.id::text || ':status:' || NEW.status) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_order_whatsapp_notification() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_order_whatsapp_notification() TO service_role;

COMMIT;
