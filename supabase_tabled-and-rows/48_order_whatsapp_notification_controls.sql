-- Canonical WhatsApp notification controls for order and payment events.
-- Safe to run repeatedly. Apply through the Supabase SQL editor before deploying.

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  event_key text PRIMARY KEY,
  display_name text NOT NULL,
  whatsapp_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.notification_preferences (event_key, display_name, whatsapp_enabled, email_enabled)
VALUES
  ('order_created', 'إنشاء الطلب', true, false),
  ('order_status_confirmed', 'تأكيد الطلب', true, false),
  ('order_status_processing', 'بدء تجهيز الطلب', false, false),
  ('order_status_shipped', 'شحن الطلب', false, false),
  ('order_status_delivered', 'تسليم الطلب', true, false),
  ('order_status_cancelled', 'إلغاء الطلب', true, false),
  ('payment_confirmed', 'تأكيد الدفع', true, false),
  ('payment_failed', 'فشل الدفع', true, false)
ON CONFLICT (event_key) DO NOTHING;

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_preferences_service_role ON public.notification_preferences;
CREATE POLICY notification_preferences_service_role
  ON public.notification_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);

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
BEGIN
  v_phone := COALESCE(NULLIF(NEW.phone, ''), (
    SELECT up.phone FROM public.user_profiles up
    WHERE up.user_id = NEW.user_id AND up.store_id = NEW.store_id
    LIMIT 1
  ));
  IF v_phone IS NULL OR v_phone = '' THEN RETURN NEW; END IF;

  v_order_ref := 'EG-' || COALESCE(NEW.order_number::text, split_part(NEW.id::text, '-', 1));

  IF TG_OP = 'INSERT' THEN
    v_event_key := 'order_created';
    v_message := 'تم تسجيل طلبكم بنجاح برقم: ' || v_order_ref || chr(10) ||
      'حالة الطلب الحالية: قيد المراجعة.' || chr(10) ||
      'نشكركم لتسوقكم من EG-PARTS.';

    IF EXISTS (SELECT 1 FROM public.notification_preferences WHERE event_key = v_event_key AND whatsapp_enabled) THEN
      INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id, idempotency_key)
      VALUES (v_phone, jsonb_build_object('message', v_message, 'event_key', v_event_key), 'whatsapp', 'pending', NEW.id, NEW.store_id,
        'order:' || NEW.id::text || ':created')
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    IF NEW.payment_status = 'paid' THEN
      v_event_key := 'payment_confirmed';
      v_message := 'تم تأكيد الدفع للطلب ' || v_order_ref || '.' || chr(10) || 'سيبدأ تجهيز طلبكم قريبًا.';
    ELSIF NEW.payment_status IN ('failed', 'cancelled', 'canceled') THEN
      v_event_key := 'payment_failed';
      v_message := 'تعذر تأكيد الدفع للطلب ' || v_order_ref || '.' || chr(10) || 'يرجى المحاولة مرة أخرى أو التواصل مع المتجر.';
    ELSE
      v_event_key := NULL;
    END IF;

    IF v_event_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.notification_preferences WHERE event_key = v_event_key AND whatsapp_enabled) THEN
      INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id, idempotency_key)
      VALUES (v_phone, jsonb_build_object('message', v_message, 'event_key', v_event_key), 'whatsapp', 'pending', NEW.id, NEW.store_id,
        'order:' || NEW.id::text || ':payment:' || NEW.payment_status)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    v_event_key := 'order_status_' || NEW.status;
    v_status_label := CASE NEW.status
      WHEN 'pending' THEN 'قيد المراجعة'
      WHEN 'confirmed' THEN 'تم التأكيد'
      WHEN 'processing' THEN 'جاري التجهيز'
      WHEN 'shipped' THEN 'تم الشحن'
      WHEN 'delivered' THEN 'تم التسليم'
      WHEN 'cancelled' THEN 'ملغي'
      ELSE NEW.status
    END;
    v_message := 'تم تحديث حالة طلبكم ' || v_order_ref || ' إلى: ' || v_status_label || '.' || chr(10) ||
      'نشكركم لاختياركم EG-PARTS.';

    IF EXISTS (SELECT 1 FROM public.notification_preferences WHERE event_key = v_event_key AND whatsapp_enabled) THEN
      INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id, idempotency_key)
      VALUES (v_phone, jsonb_build_object('message', v_message, 'event_key', v_event_key), 'whatsapp', 'pending', NEW.id, NEW.store_id,
        'order:' || NEW.id::text || ':status:' || NEW.status)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_order_status_notification ON public.orders;
DROP TRIGGER IF EXISTS tr_new_order_notification ON public.orders;
DROP TRIGGER IF EXISTS tr_order_whatsapp_notification ON public.orders;
CREATE TRIGGER tr_order_whatsapp_notification
AFTER INSERT OR UPDATE OF status, payment_status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.queue_order_whatsapp_notification();

REVOKE ALL ON FUNCTION public.queue_order_whatsapp_notification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_order_whatsapp_notification() TO service_role;

CREATE INDEX IF NOT EXISTS notification_queue_order_event_idx
  ON public.notification_queue (order_id, store_id, created_at DESC);
