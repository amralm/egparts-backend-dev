-- ============================================================
-- SQL Migration: SaaS Platform Core Architecture (Phase 2)
-- Run in Supabase SQL Editor to establish relational RBAC, Plans,
-- invitations, correlation audits, and batch-tracked stock.
-- ============================================================

-- 1. Relational RBAC Setup
CREATE TABLE IF NOT EXISTS public.permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL, -- e.g., 'products.create', 'orders.update'
    description TEXT,
    is_deprecated BOOLEAN DEFAULT false,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE, -- NULL for platform global roles
    name TEXT NOT NULL, -- e.g., 'manager', 'cashier'
    display_name TEXT NOT NULL,
    priority INTEGER DEFAULT 10, -- Lower priority numbers represent higher precedence
    system_role BOOLEAN DEFAULT false,
    editable BOOLEAN DEFAULT true,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT store_role_unique UNIQUE(store_id, name)
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id UUID REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES public.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    role_id UUID REFERENCES public.roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, store_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);

-- 2. Subscription Engine Setup
CREATE TABLE IF NOT EXISTS public.plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL, -- e.g., 'basic', 'pro', 'enterprise'
    display_name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_public BOOLEAN DEFAULT true,
    is_default BOOLEAN DEFAULT false,
    description TEXT,
    price_monthly NUMERIC NOT NULL DEFAULT 0,
    price_yearly NUMERIC NOT NULL DEFAULT 0,
    trial_days INTEGER DEFAULT 0,
    trial_enabled BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL, -- e.g., 'products', 'branches', 'whatsapp_notifications', 'ai_credits'
    display_name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.plan_features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    feature_id UUID NOT NULL REFERENCES public.features(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT plan_feature_unique UNIQUE(plan_id, feature_id)
);

CREATE TABLE IF NOT EXISTS public.feature_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_feature_id UUID NOT NULL REFERENCES public.plan_features(id) ON DELETE CASCADE,
    limit_type TEXT NOT NULL DEFAULT 'count', -- count, boolean, rate, storage_bytes
    limit_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g., {"max_value": 100}
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT feature_limit_key_unique UNIQUE(plan_feature_id, limit_type)
);

CREATE TABLE IF NOT EXISTS public.store_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID UNIQUE NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active', -- active, trial, suspended, canceled
    started_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Tenant Invitation System
CREATE TABLE IF NOT EXISTS public.tenant_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, expired, revoked
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    created_ip TEXT,
    accepted_ip TEXT,
    resent_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token ON public.tenant_invitations(token);

-- 4. Audit Logs System
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL, -- Correlation ID to link request context
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, -- e.g., 'delete_product', 'change_role', 'price_change'
    entity_type TEXT NOT NULL, -- 'product', 'user', 'store', etc.
    entity_id TEXT NOT NULL,
    old_values JSONB DEFAULT '{}'::jsonb,
    new_values JSONB DEFAULT '{}'::jsonb,
    ip_address TEXT,
    user_agent TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON public.audit_logs(correlation_id);

-- 5. Multi-Branch Hierarchy Setup
CREATE TABLE IF NOT EXISTS public.branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shelves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    batch_number TEXT NOT NULL,
    supplier_batch TEXT,
    expiry_date TIMESTAMPTZ,
    manufacturing_date TIMESTAMPTZ,
    lot_number TEXT,
    serial_tracking BOOLEAN DEFAULT false,
    country_of_origin TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_stock (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    shelf_id UUID NOT NULL REFERENCES public.shelves(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES public.product_batches(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT product_shelf_batch_unique UNIQUE (product_id, shelf_id, batch_id)
);

-- ============================================================
-- Seeding & Migration Alter statements (Idempotent updates)
-- ============================================================

-- Alter tables to add columns if they already exist
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 0;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS trial_enabled BOOLEAN DEFAULT false;
ALTER TABLE public.tenant_invitations ADD COLUMN IF NOT EXISTS resent_count INTEGER DEFAULT 0;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- Create system settings table for Schema Version
CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed Schema Version
INSERT INTO public.system_settings (key, value)
VALUES ('schema_version', '2.5.0-beta.1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Seed Default Permissions
INSERT INTO public.permissions (name, description, version) VALUES
('platform.health.read', 'Allows viewing the centralized operational health dashboard', 1)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- Seed Default Platform Global Roles
INSERT INTO public.roles (name, display_name, priority, system_role, editable, description) VALUES
('super_admin', 'Super Administrator', 1, true, false, 'Platform-wide super administrator with full system permissions')
ON CONFLICT (store_id, name) DO UPDATE SET display_name = EXCLUDED.display_name;

-- Map platform.health.read to super_admin role
DO $$
DECLARE
    v_role_id UUID;
    v_perm_id UUID;
BEGIN
    SELECT id INTO v_role_id FROM public.roles WHERE store_id IS NULL AND name = 'super_admin';
    SELECT id INTO v_perm_id FROM public.permissions WHERE name = 'platform.health.read';
    
    IF v_role_id IS NOT NULL AND v_perm_id IS NOT NULL THEN
        INSERT INTO public.role_permissions (role_id, permission_id)
        VALUES (v_role_id, v_perm_id)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
