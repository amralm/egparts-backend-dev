-- Migration 35: Entitlements Engine & Policy Engine Schema

-- 1. Feature Categories
CREATE TABLE IF NOT EXISTS public.feature_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0
);

-- 2. Capabilities (Feature Definitions)
DO $$ BEGIN
    CREATE TYPE capability_type AS ENUM ('BOOLEAN', 'NUMERIC', 'ENUM', 'UNLIMITED', 'ADDON', 'METERED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE limit_type AS ENUM ('HARD', 'SOFT', 'BURST');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS public.capabilities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(100) UNIQUE NOT NULL, -- e.g. products.create
    category_id UUID REFERENCES public.feature_categories(id),
    name VARCHAR(100) NOT NULL,
    type capability_type NOT NULL,
    default_limit_type limit_type DEFAULT 'HARD',
    unit VARCHAR(50), -- e.g. 'requests/month', 'GB'
    default_value JSONB, -- fallback value
    is_active BOOLEAN DEFAULT true,
    depends_on VARCHAR(100), -- capability code it depends on
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Bundles
CREATE TABLE IF NOT EXISTS public.bundles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.bundle_capabilities (
    bundle_id UUID REFERENCES public.bundles(id) ON DELETE CASCADE,
    capability_id UUID REFERENCES public.capabilities(id) ON DELETE CASCADE,
    limit_value JSONB NOT NULL,
    PRIMARY KEY (bundle_id, capability_id)
);

-- 4. Plan Versions
CREATE TABLE IF NOT EXISTS public.plan_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id UUID REFERENCES public.plans(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'DRAFT', -- DRAFT, PUBLISHED, ARCHIVED
    price_monthly NUMERIC(10,2),
    price_yearly NUMERIC(10,2),
    trial_days INTEGER DEFAULT 0,
    effective_from TIMESTAMPTZ,
    effective_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (plan_id, version_number)
);

-- 5. Plan Version Bundles & Overrides
CREATE TABLE IF NOT EXISTS public.plan_version_bundles (
    plan_version_id UUID REFERENCES public.plan_versions(id) ON DELETE CASCADE,
    bundle_id UUID REFERENCES public.bundles(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_version_id, bundle_id)
);

CREATE TABLE IF NOT EXISTS public.plan_version_capabilities (
    plan_version_id UUID REFERENCES public.plan_versions(id) ON DELETE CASCADE,
    capability_id UUID REFERENCES public.capabilities(id) ON DELETE CASCADE,
    limit_value JSONB NOT NULL,
    PRIMARY KEY (plan_version_id, capability_id)
);

-- 6. Store Overrides & Addons
CREATE TABLE IF NOT EXISTS public.store_feature_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    capability_id UUID REFERENCES public.capabilities(id) ON DELETE CASCADE,
    limit_value JSONB NOT NULL,
    reason TEXT,
    granted_by UUID REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.store_addons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    bundle_id UUID REFERENCES public.bundles(id) ON DELETE CASCADE,
    purchased_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    auto_renew BOOLEAN DEFAULT false
);

-- 7. Cost Metrics
CREATE TABLE IF NOT EXISTS public.cost_metrics (
    capability_id UUID PRIMARY KEY REFERENCES public.capabilities(id) ON DELETE CASCADE,
    cost_per_unit NUMERIC(10,4) NOT NULL,
    currency VARCHAR(3) DEFAULT 'EGP',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Auditing & Logging
CREATE TABLE IF NOT EXISTS public.entitlement_decisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL, -- no FK to allow fast inserts
    capability_code VARCHAR(100) NOT NULL,
    requested_action VARCHAR(50),
    is_allowed BOOLEAN NOT NULL,
    reason TEXT,
    usage JSONB,
    applied_limit JSONB,
    decision_source VARCHAR(50), -- Emergency, Override, Addon, Plan
    latency_ms INTEGER,
    decision_time TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.usage_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    metrics JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, snapshot_date)
);

-- 9. Ban System
DO $$ BEGIN
    CREATE TYPE ban_scope_type AS ENUM ('LOGIN', 'ORDERS', 'ADMIN', 'CHAT', 'PAYMENTS', 'STORE', 'ALL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS public.ban_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE, -- if tenant ban
    ban_scope ban_scope_type DEFAULT 'ALL',
    ban_type VARCHAR(50), -- Fraud, Spam, Terms Violation, etc.
    is_temporary BOOLEAN DEFAULT false,
    banned_until TIMESTAMPTZ,
    reason TEXT NOT NULL,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    lifted_by UUID REFERENCES auth.users(id),
    lifted_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true
);

-- 10. Impersonation Sessions
CREATE TABLE IF NOT EXISTS public.impersonation_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_token UUID UNIQUE DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    ip_address INET,
    user_agent TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT true
);

-- 11. Platform Events
CREATE TABLE IF NOT EXISTS public.platform_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(100) NOT NULL, -- e.g. PlanPublished, ImpersonationStarted
    payload JSONB NOT NULL,
    triggered_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Permissions Update
INSERT INTO public.permissions (code, name, description, priority)
VALUES 
    ('platform.plan.read', 'View Plans', 'View platform plans and versions', 1),
    ('platform.plan.write', 'Manage Plans', 'Create and modify platform plans', 1),
    ('platform.users.ban', 'Ban Users', 'Ban users or stores', 1),
    ('platform.users.unban', 'Unban Users', 'Unban users or stores', 1),
    ('platform.impersonate', 'Impersonate Store', 'Impersonate a store', 1)
ON CONFLICT (code) DO NOTHING;

-- Assign to Super Admin
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.name = 'super_admin'
AND p.code IN ('platform.plan.read', 'platform.plan.write', 'platform.users.ban', 'platform.users.unban', 'platform.impersonate')
ON CONFLICT DO NOTHING;
