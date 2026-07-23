const { Client } = require('pg');
const client = new Client('postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres');

async function fix() {
  await client.connect();
  const sql = `
CREATE OR REPLACE FUNCTION public.handle_order_status_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_store_name text;
  v_status_label text;
  v_order_num text;
  v_msg text;
BEGIN
  -- Skip if status didn't actually change
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- Only send notification for 'confirmed' status
  IF NEW.status != 'confirmed' THEN
    RETURN NEW;
  END IF;

  -- Get store name
  SELECT name INTO v_store_name FROM public.stores WHERE id = NEW.store_id;
  v_store_name := COALESCE(v_store_name, 'المتجر');

  -- Build order number
  v_order_num := COALESCE(NEW.order_number::text, split_part(NEW.id::text, '-', 1));

  -- Map status to Arabic label
  v_status_label := 'تم التأكيد';

  -- Build professional Arabic message without emojis
  v_msg := 'تحديث حالة الطلب'
    || chr(10) || chr(10)
    || 'مرحباً من ' || v_store_name
    || chr(10) || chr(10)
    || 'رقم الطلب: EG-' || v_order_num
    || chr(10) || chr(10)
    || 'تم تحديث حالة طلبكم إلى:'
    || chr(10) || '「' || v_status_label || '」'
    || chr(10) || chr(10)
    || 'الإجمالي: ' || COALESCE(NEW.total::text, '0') || ' جنيه'
    || chr(10) || chr(10)
    || 'شكراً لتسوقكم معنا!';

  INSERT INTO public.notification_queue (recipient, payload, type, status, order_id, store_id)
  VALUES (
    NEW.phone,
    jsonb_build_object(
      'message', v_msg,
      'event_type', 'order_status_changed',
      'order_number', 'EG-' || v_order_num,
      'old_status', OLD.status,
      'new_status', NEW.status
    ),
    'whatsapp',
    'pending',
    NEW.id,
    NEW.store_id
  );
  RETURN NEW;
END;
$$;
  `;
  await client.query(sql);
  console.log('Trigger fixed successfully!');
  await client.end();
}
fix();
