-- Migration for Paymob Production Enhancements

-- 1. Create Payment Audit Logs Table
CREATE TABLE IF NOT EXISTS public.payment_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    transaction_id TEXT,
    gateway_name TEXT NOT NULL DEFAULT 'paymob',
    event_type TEXT NOT NULL, -- 'webhook_received', 'payment_success', 'payment_failed', 'hmac_failed'
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.payment_audit_logs ENABLE ROW LEVEL SECURITY;

-- Super Admin Policy
CREATE POLICY "Super Admins can view all payment logs"
ON public.payment_audit_logs FOR SELECT
USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true));

-- Store Admin Policy
CREATE POLICY "Store Admins can view their payment logs"
ON public.payment_audit_logs FOR SELECT
USING (store_id IN (
    SELECT store_id FROM user_profiles 
    WHERE user_id = auth.uid() AND role IN ('admin', 'owner')
));

-- 2. Add RPC to cancel expired unpaid card orders and restore stock
CREATE OR REPLACE FUNCTION public.cancel_expired_pending_orders(p_minutes_old INT DEFAULT 30)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_cancelled_count INT := 0;
    v_order RECORD;
    v_item RECORD;
BEGIN
    FOR v_order IN 
        SELECT id, store_id, items 
        FROM public.orders
        WHERE payment_method = 'card' 
          AND payment_status = 'pending' 
          AND status = 'pending'
          AND created_at < NOW() - (p_minutes_old || ' minutes')::interval
    LOOP
        -- Restore stock for this order
        FOR v_item IN SELECT * FROM jsonb_to_recordset(v_order.items) AS x(id text, qty int)
        LOOP
            UPDATE public.products
            SET stock_quantity = stock_quantity + v_item.qty,
                stock = GREATEST(COALESCE(stock, stock_quantity) + v_item.qty, 0)
            WHERE id = v_item.id::uuid AND store_id = v_order.store_id;
        END LOOP;

        -- Cancel order
        UPDATE public.orders
        SET status = 'cancelled',
            payment_status = 'expired'
        WHERE id = v_order.id;

        -- Audit Log
        INSERT INTO public.payment_audit_logs (store_id, order_id, event_type, payload)
        VALUES (v_order.store_id, v_order.id, 'payment_expired', jsonb_build_object('reason', 'expired_after_30_mins'));

        v_cancelled_count := v_cancelled_count + 1;
    END LOOP;

    RETURN v_cancelled_count;
END;
$$;
