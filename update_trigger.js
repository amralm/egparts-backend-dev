const { Client } = require('pg');
const client = new Client('postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres');

async function updateTrigger() {
  await client.connect();
  const sql = `
CREATE OR REPLACE FUNCTION public.log_order_status_change()
RETURNS trigger AS $$
DECLARE
  v_status_label text;
  v_order_num text;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        -- Map status to Arabic labels
        v_status_label := CASE NEW.status
          WHEN 'pending'    THEN 'قيد المراجعة'
          WHEN 'confirmed'  THEN 'تم التأكيد'
          WHEN 'processing' THEN 'جاري التجهيز'
          WHEN 'shipped'    THEN 'تم الشحن'
          WHEN 'delivered'  THEN 'تم التسليم'
          WHEN 'cancelled'  THEN 'ملغي'
          WHEN 'returned'   THEN 'مرتجع'
          ELSE NEW.status
        END;

        -- Extract order number safely
        v_order_num := COALESCE(NEW.order_number::text, split_part(NEW.id::text, '-', 1));

        -- Insert order tracking record
        INSERT INTO public.order_tracking (order_id, store_id, status, note)
        VALUES (NEW.id, NEW.store_id, NEW.status, 'تم تحديث حالة الطلب إلى: ' || v_status_label);
        
        -- Send notification to user
        IF NEW.user_id IS NOT NULL THEN
            INSERT INTO public.user_notifications (user_id, store_id, title, message, type, order_id)
            VALUES (
                NEW.user_id, 
                NEW.store_id, 
                'تم تحديث حالة طلبك', 
                'طلب EG-' || v_order_num || ' تم نقله إلى: ' || v_status_label, 
                'order_update',
                NEW.id
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
  `;
  try {
    await client.query(sql);
    console.log('Trigger function updated successfully!');
  } catch (err) {
    console.error('Error updating trigger:', err);
  } finally {
    await client.end();
  }
}

updateTrigger();
