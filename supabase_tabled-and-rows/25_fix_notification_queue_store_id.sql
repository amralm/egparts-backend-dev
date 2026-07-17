-- ============================================================
-- SQL Update: Fix notification_queue store_id Null Constraint Violation
-- Run in Supabase SQL Editor to fix checkout failures
-- ============================================================

-- 1. Update the order status notification trigger function
CREATE OR REPLACE FUNCTION public.handle_order_status_notification()
RETURNS TRIGGER AS $$
DECLARE
  v_status_label text;
BEGIN
  -- Convert status key to professional Arabic labels
  v_status_label := CASE NEW.status
    WHEN 'pending' THEN 'قيد المراجعة'
    WHEN 'confirmed' THEN 'تم التأكيد'
    WHEN 'processing' THEN 'جاري التجهيز'
    WHEN 'shipped' THEN 'تم الشحن'
    WHEN 'delivered' THEN 'تم التسليم'
    WHEN 'cancelled' THEN 'ملغي'
    ELSE NEW.status
  END;

  -- Only queue a notification if the status actually changed
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id)
    VALUES (
      NEW.phone,
      jsonb_build_object('message', 
        'إشعار تحديث الطلب EG-' || COALESCE(NEW.order_number::text, split_part(NEW.id::text, '-', 1)) || chr(10) || chr(10) ||
        'تم تحديث حالة طلبكم لتصبح: ' || v_status_label || chr(10) ||
        'نشكركم لاختياركم EG-PARTS.'
      ),
      'whatsapp',
      'pending',
      NEW.id,
      NEW.store_id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger on orders table for updates
DROP TRIGGER IF EXISTS tr_order_status_notification ON public.orders;
CREATE TRIGGER tr_order_status_notification
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_order_status_notification();


-- 2. Update the new order notification trigger function
CREATE OR REPLACE FUNCTION public.handle_new_order_notification()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id)
  VALUES (
    NEW.phone,
    jsonb_build_object('message', 
      'تم تسجيل طلبكم بنجاح برقم: EG-' || COALESCE(NEW.order_number::text, split_part(NEW.id::text, '-', 1)) || chr(10) ||
      'حالة الطلب الحالية: قيد الانتظار (في انتظار التأكيد).' || chr(10) ||
      'نشكركم لتسوقكم من EG-PARTS.'
    ),
    'whatsapp',
    'pending',
    NEW.id,
    NEW.store_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger on orders table for inserts
DROP TRIGGER IF EXISTS tr_new_order_notification ON public.orders;
CREATE TRIGGER tr_new_order_notification
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_order_notification();
