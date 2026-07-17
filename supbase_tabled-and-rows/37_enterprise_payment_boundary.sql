-- 1. Create Payment Intents Table
CREATE TABLE IF NOT EXISTS public.payment_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'EGP',
    status VARCHAR(20) NOT NULL CHECK (status IN ('created', 'processing', 'authorized', 'captured', 'failed', 'cancelled')),
    provider VARCHAR(50) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create Payment Intent Transactions (Renamed to avoid collision)
CREATE TABLE IF NOT EXISTS public.payment_intent_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id UUID NOT NULL REFERENCES public.payment_intents(id) ON DELETE CASCADE,
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('auth', 'capture', 'refund')),
    provider_reference TEXT,
    amount_cents INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Create Payment Timelines Table
CREATE TABLE IF NOT EXISTS public.payment_timelines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id UUID NOT NULL REFERENCES public.payment_intents(id) ON DELETE CASCADE,
    event_name VARCHAR(50) NOT NULL,
    description TEXT,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Create Payment Outbox Table
CREATE TABLE IF NOT EXISTS public.payment_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    processed_at TIMESTAMPTZ
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON public.payment_intents(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_intent_transactions_intent ON public.payment_intent_transactions(intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_timelines_intent ON public.payment_timelines(intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_outbox_status ON public.payment_outbox(status) WHERE status = 'pending';

-- Enable Row Level Security (RLS) on all tables for security hardening
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intent_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_timelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_outbox ENABLE ROW LEVEL SECURITY;
