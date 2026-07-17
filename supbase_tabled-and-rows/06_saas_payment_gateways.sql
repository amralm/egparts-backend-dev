-- ============================================================
-- SQL Migration: SaaS Platform Core Phase 3 - Payment Gateways & Domain Monitoring
-- Run in Supabase SQL Editor to establish:
--   1. Payment Provider Registry (Stripe, Paymob, PayPal, Fawry, Manual, Mock)
--   2. Payment Transaction Audit Log
--   3. Custom Domain Health Check Records
--   4. Tenant Invitation Status Constraint Update
-- ============================================================

-- 1. Create Payment Providers Table
CREATE TABLE IF NOT EXISTS public.payment_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL, -- 'mock', 'stripe', 'paymob', 'paypal', 'fawry', 'bank'
    display_name TEXT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    sandbox BOOLEAN DEFAULT true,
    configuration TEXT, -- Encrypted JSON string
    priority INTEGER DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default payment providers
INSERT INTO public.payment_providers (code, display_name, enabled, sandbox, priority) VALUES
('mock', 'بوابة الدفع التجريبية (Mock)', true, true, 1),
('stripe', 'بوابة Stripe الدولية', false, true, 2),
('paymob', 'بوابة Paymob المحلية', false, true, 3),
('paypal', 'بوابة PayPal', false, true, 4),
('fawry', 'خدمة فوري للدفع', false, true, 5),
('bank', 'تحويل بنكي / يدوي', true, false, 6)
ON CONFLICT (code) DO NOTHING;

-- 2. Create Payment Transactions Table
CREATE TABLE IF NOT EXISTS public.payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    provider_transaction_id TEXT,
    subscription_id UUID REFERENCES public.store_subscriptions(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES public.invoices(id) ON DELETE CASCADE,
    status TEXT NOT NULL, -- 'pending', 'completed', 'failed', 'refunded', 'voided'
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EGP',
    request_payload JSONB DEFAULT '{}'::jsonb,
    response_payload JSONB DEFAULT '{}'::jsonb,
    idempotency_key TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_invoice ON public.payment_transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider ON public.payment_transactions(provider_transaction_id);

-- 3. Create Domain Health Checks Table
CREATE TABLE IF NOT EXISTS public.domain_health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id UUID NOT NULL REFERENCES public.custom_domains(id) ON DELETE CASCADE,
    checked_at TIMESTAMPTZ DEFAULT now(),
    dns_status TEXT NOT NULL CHECK (dns_status IN ('pending', 'valid', 'invalid', 'error')),
    ssl_status TEXT NOT NULL CHECK (ssl_status IN ('pending', 'valid', 'invalid', 'expired', 'error')),
    http_status TEXT CHECK (http_status IN ('online', 'offline', 'error')),
    latency_ms INTEGER,
    certificate_expiry TIMESTAMPTZ,
    resolved_records JSONB DEFAULT '{}'::jsonb,
    error_code TEXT,
    error_message TEXT,
    next_retry_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_domain_health_checks_domain ON public.domain_health_checks(domain_id);
CREATE INDEX IF NOT EXISTS idx_domain_health_checks_time ON public.domain_health_checks(checked_at DESC);

-- 4. Align Tenant Invitation Status constraints
ALTER TABLE public.tenant_invitations DROP CONSTRAINT IF EXISTS chk_tenant_invitations_status;
ALTER TABLE public.tenant_invitations ADD CONSTRAINT chk_tenant_invitations_status CHECK (
    status IN ('pending', 'sent', 'opened', 'accepted', 'expired', 'revoked', 'failed', 'completed')
);
