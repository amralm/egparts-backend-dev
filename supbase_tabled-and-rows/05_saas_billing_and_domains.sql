-- ============================================================
-- SQL Migration: SaaS Platform Core Phase 2 - Billing & Domains
-- Run in Supabase SQL Editor to establish:
--   1. Expanded RBAC (Platform vs Tenant, system role templates)
--   2. Custom Domains Lifecycle tracking
--   3. Subscriptions & Billing Ledger
--   4. Unified Notifications Templates & Queue
-- ============================================================

-- 1. Extend existing tables
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false;
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS role_type TEXT NOT NULL DEFAULT 'tenant' CHECK (role_type IN ('platform', 'tenant_template', 'tenant'));

-- Update existing super_admin global role to be recognized as a platform role
UPDATE public.roles SET role_type = 'platform' WHERE store_id IS NULL AND name = 'super_admin';

-- 2. Custom Domains Lifecycle Table
CREATE TABLE IF NOT EXISTS public.custom_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    domain TEXT UNIQUE NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (status IN (
        'pending_verification', 'pending_dns', 'dns_valid', 'ssl_provisioning', 
        'active', 'warning', 'failed', 'suspended', 'disabled'
    )),
    verification_token TEXT NOT NULL,
    verified_at TIMESTAMPTZ,
    last_dns_check TIMESTAMPTZ,
    ssl_status TEXT NOT NULL DEFAULT 'none' CHECK (ssl_status IN ('none', 'active', 'failed')),
    last_ssl_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_store ON public.custom_domains(store_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON public.custom_domains(domain);

-- 3. Billing Ledger Tables
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES public.store_subscriptions(id) ON DELETE CASCADE,
    invoice_number TEXT UNIQUE NOT NULL, -- Sequential format like INV-2026-0001
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'draft', 'pending', 'paid', 'partially_paid', 'failed', 'refunded', 'cancelled', 'overdue'
    )),
    currency TEXT NOT NULL DEFAULT 'EGP',
    subtotal NUMERIC NOT NULL DEFAULT 0,
    tax_rate NUMERIC NOT NULL DEFAULT 0,
    tax_amount NUMERIC NOT NULL DEFAULT 0,
    discount_amount NUMERIC NOT NULL DEFAULT 0,
    total NUMERIC NOT NULL DEFAULT 0,
    amount_paid NUMERIC NOT NULL DEFAULT 0,
    due_date TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC NOT NULL DEFAULT 0,
    amount NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'EGP',
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    payment_method TEXT NOT NULL, -- e.g., 'paymob', 'stripe', 'bank_transfer', 'cash'
    gateway_reference TEXT,
    paid_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL DEFAULT 0,
    reason TEXT,
    refunded_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
    discount_value NUMERIC NOT NULL,
    expires_at TIMESTAMPTZ,
    max_redemptions INTEGER,
    redemptions_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Notification Template & Layouts
CREATE TABLE IF NOT EXISTS public.notification_layouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    header_html TEXT,
    footer_html TEXT,
    css TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL, -- e.g. 'tenant_invitation', 'invoice_paid'
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms', 'push', 'in_app')),
    language TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar', 'en')),
    subject TEXT,
    body_html TEXT NOT NULL,
    body_text TEXT,
    layout_id UUID REFERENCES public.notification_layouts(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT template_code_channel_lang UNIQUE(code, channel, language)
);

CREATE TABLE IF NOT EXISTS public.notification_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID REFERENCES public.notification_templates(id) ON DELETE SET NULL,
    recipient TEXT NOT NULL, -- Phone number or email
    channel TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'pending')),
    provider TEXT, -- e.g. 'smtp', 'twilio', 'baileys'
    provider_message_id TEXT,
    rendered_subject TEXT,
    rendered_body TEXT,
    error_message TEXT,
    duration_ms INTEGER,
    sent_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Seed Core Platform Permissions
INSERT INTO public.permissions (name, description, version) VALUES
('platform.settings.write', 'Allows modifying global system settings', 1),
('platform.plans.write', 'Allows creating and editing SaaS subscription plans', 1),
('platform.tenants.write', 'Allows provisioning stores and inviting owners', 1),
('platform.audit.read', 'Allows inspecting platform-wide audit logs', 1),
('platform.domains.write', 'Allows configuring and verifying custom domains', 1),
('platform.notifications.write', 'Allows modifying layouts and email/whatsapp templates', 1),
('platform.billing.write', 'Allows managing subscription plans, invoices, and payment audits', 1)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- Map new platform permissions to super_admin role
DO $$
DECLARE
    v_role_id UUID;
    v_perm_rec RECORD;
BEGIN
    SELECT id INTO v_role_id FROM public.roles WHERE store_id IS NULL AND name = 'super_admin';
    
    IF v_role_id IS NOT NULL THEN
        FOR v_perm_rec IN 
            SELECT id FROM public.permissions 
            WHERE name IN (
                'platform.settings.write', 'platform.plans.write', 'platform.tenants.write', 
                'platform.audit.read', 'platform.domains.write', 'platform.notifications.write',
                'platform.billing.write'
            )
        LOOP
            INSERT INTO public.role_permissions (role_id, permission_id)
            VALUES (v_role_id, v_perm_rec.id)
            ON CONFLICT DO NOTHING;
        END LOOP;
    END IF;
END $$;

-- Seed Default Store Roles as System Templates (store_id = NULL, role_type = 'tenant_template')
INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, role_type, description) VALUES
(NULL, 'owner', 'صاحب المتجر', 1, true, false, 'tenant_template', 'المالك والمشرف العام للمتجر بصلاحيات كاملة'),
(NULL, 'store_manager', 'مدير المتجر', 2, true, true, 'tenant_template', 'صلاحيات الإشراف الإداري على الفروع والمخزون والمبيعات'),
(NULL, 'inventory_manager', 'أمين المستودع', 3, true, true, 'tenant_template', 'صلاحيات جرد المستودعات وإدارة الفروع والأرفف والمنتجات'),
(NULL, 'purchasing_manager', 'مدير المشتريات', 4, true, true, 'tenant_template', 'صلاحيات تتبع الموردين وتوليد الدفعات والطلب'),
(NULL, 'sales_manager', 'مدير المبيعات', 5, true, true, 'tenant_template', 'إدارة تسعير المنتجات، والخصومات، وتتبع الفواتير والطلبات'),
(NULL, 'cashier', 'كاشير / بائع', 6, true, true, 'tenant_template', 'صلاحيات تسجيل فواتير البيع وقراءة المنتجات وتحديث حالة الطلبات'),
(NULL, 'accountant', 'المحاسب', 7, true, true, 'tenant_template', 'الاطلاع على التقارير المالية وسجلات الدفع والفواتير والتكاليف'),
(NULL, 'customer_support', 'خدمة العملاء', 8, true, true, 'tenant_template', 'تعديل حالات الطلبات ومراجعات العملاء وتتبع الشحن'),
(NULL, 'marketing', 'التسويق والمحتوى', 9, true, true, 'tenant_template', 'إدارة لافتات العروض والخصومات وتحديث محتوى الكتالوج'),
(NULL, 'read_only', 'عرض فقط', 10, true, false, 'tenant_template', 'صلاحيات عرض لوحة التحكم وقراءة الكتالوج والمبيعات دون إدخال تعديلات')
ON CONFLICT (store_id, name) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description;
