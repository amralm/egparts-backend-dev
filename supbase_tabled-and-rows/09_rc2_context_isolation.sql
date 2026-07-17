-- ============================================================
-- RC2 Final Context Isolation Migration
-- Purpose:
--   - Platform is not a tenant and does not require fake store membership.
--   - Platform permissions are platform.* only.
--   - Tenant permissions are tenant.* only.
--   - Remove legacy app_metadata-driven RLS policies that may still exist.
--   - Provide explicit platform and tenant permission helper functions.
-- Run after 07_production_rc1_hardening.sql.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- Permission helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.super_admins sa
    WHERE sa.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.has_platform_permission(p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_owner()
  AND EXISTS (
    SELECT 1
    FROM public.roles r
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.store_id IS NULL
      AND r.role_type = 'platform'
      AND r.name = 'super_admin'
      AND p.name = p_permission
      AND COALESCE(p.is_deprecated, false) = false
  );
$$;

CREATE OR REPLACE FUNCTION public.has_tenant_permission(p_store_id uuid, p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND ur.store_id = p_store_id
      AND r.store_id = p_store_id
      AND r.role_type = 'tenant'
      AND p.name = p_permission
      AND COALESCE(p.is_deprecated, false) = false
  );
$$;

-- Keep existing helper name, but make intent explicit.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_owner();
$$;

CREATE OR REPLACE FUNCTION public.has_permission(p_permission text, p_store_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_permission LIKE 'platform.%' THEN public.has_platform_permission(p_permission)
    WHEN p_permission LIKE 'tenant.%' THEN p_store_id IS NOT NULL AND public.has_tenant_permission(p_store_id, p_permission)
    ELSE false
  END;
$$;

-- ------------------------------------------------------------
-- RBAC namespace hardening
-- ------------------------------------------------------------
INSERT INTO public.permissions (name, description, version) VALUES
('platform.access','Access platform context and platform APIs',2),
('platform.health.read','View platform health dashboard',2),
('platform.settings.write','Manage platform settings',2),
('platform.tenants.write','Create, suspend, recover, delete tenants',2),
('platform.plans.write','Manage SaaS plans and limits',2),
('platform.billing.write','Manage invoices, payments, refunds, subscriptions',2),
('platform.domains.write','Manage custom domains and domain verification',2),
('platform.notifications.write','Manage global notification layouts and templates',2),
('platform.audit.read','Read all platform audit logs',2),
('platform.storage.write','Manage platform storage assets',2),
('tenant.products.read','Read tenant products',2),
('tenant.products.write','Create and update tenant products',2),
('tenant.products.delete','Delete or archive tenant products',2),
('tenant.orders.read','Read tenant orders',2),
('tenant.orders.write','Update tenant orders',2),
('tenant.inventory.read','Read tenant inventory',2),
('tenant.inventory.write','Adjust tenant inventory',2),
('tenant.branches.manage','Manage tenant branches, warehouses, shelves',2),
('tenant.customers.read','Read tenant customers',2),
('tenant.customers.write','Update tenant customers',2),
('tenant.marketing.write','Manage tenant banners, reviews, content, coupons',2),
('tenant.settings.write','Manage tenant settings',2),
('tenant.reports.read','Read tenant reports and dashboard metrics',2),
('tenant.support.write','Manage tenant support and tracking',2),
('tenant.finance.read','Read tenant financial data',2)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, version = EXCLUDED.version;

-- Deprecate non-namespaced tenant permissions after tenant.* aliases exist.
UPDATE public.permissions
SET is_deprecated = true, version = GREATEST(version, 2)
WHERE name IN (
  'products.read','products.write','products.delete','orders.read','orders.write',
  'inventory.read','inventory.write','branches.manage','customers.read','customers.write',
  'marketing.write','settings.write','reports.read','support.write','finance.read'
);

-- Ensure platform role exists without fake tenant store.
WITH seed AS (
  SELECT NULL::uuid AS store_id, 'super_admin'::text AS name, 'Platform Owner'::text AS display_name,
         0::integer AS priority, true AS system_role, false AS editable,
         'platform'::text AS role_type, 'Owns and manages the SaaS platform'::text AS description
), upd AS (
  UPDATE public.roles r
  SET display_name = seed.display_name,
      priority = seed.priority,
      system_role = seed.system_role,
      editable = seed.editable,
      role_type = seed.role_type,
      description = seed.description
  FROM seed
  WHERE r.store_id IS NULL AND r.name = seed.name
  RETURNING r.id
)
INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, role_type, description)
SELECT store_id, name, display_name, priority, system_role, editable, role_type, description
FROM seed
WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE store_id IS NULL AND name = 'super_admin');

WITH platform_role AS (
  SELECT id FROM public.roles WHERE store_id IS NULL AND role_type = 'platform' AND name = 'super_admin'
), platform_perms AS (
  SELECT id FROM public.permissions WHERE name LIKE 'platform.%' AND COALESCE(is_deprecated, false) = false
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT platform_role.id, platform_perms.id
FROM platform_role, platform_perms
ON CONFLICT DO NOTHING;

-- Tenant template role permissions in tenant.* namespace.
WITH role_perm(role_name, perm_name) AS (
  VALUES
  ('owner','tenant.products.read'),('owner','tenant.products.write'),('owner','tenant.products.delete'),('owner','tenant.orders.read'),('owner','tenant.orders.write'),('owner','tenant.inventory.read'),('owner','tenant.inventory.write'),('owner','tenant.branches.manage'),('owner','tenant.customers.read'),('owner','tenant.customers.write'),('owner','tenant.marketing.write'),('owner','tenant.settings.write'),('owner','tenant.reports.read'),('owner','tenant.support.write'),('owner','tenant.finance.read'),
  ('admin','tenant.products.read'),('admin','tenant.products.write'),('admin','tenant.products.delete'),('admin','tenant.orders.read'),('admin','tenant.orders.write'),('admin','tenant.inventory.read'),('admin','tenant.inventory.write'),('admin','tenant.branches.manage'),('admin','tenant.customers.read'),('admin','tenant.customers.write'),('admin','tenant.marketing.write'),('admin','tenant.settings.write'),('admin','tenant.reports.read'),('admin','tenant.support.write'),('admin','tenant.finance.read'),
  ('manager','tenant.products.read'),('manager','tenant.orders.read'),('manager','tenant.orders.write'),('manager','tenant.inventory.read'),('manager','tenant.customers.read'),('manager','tenant.reports.read'),
  ('sales','tenant.products.read'),('sales','tenant.orders.read'),('sales','tenant.orders.write'),('sales','tenant.customers.read'),
  ('cashier','tenant.products.read'),('cashier','tenant.orders.read'),('cashier','tenant.orders.write'),
  ('inventory','tenant.products.read'),('inventory','tenant.products.write'),('inventory','tenant.inventory.read'),('inventory','tenant.inventory.write'),
  ('warehouse','tenant.inventory.read'),('warehouse','tenant.inventory.write'),('warehouse','tenant.branches.manage'),
  ('purchasing','tenant.products.read'),('purchasing','tenant.inventory.read'),('purchasing','tenant.inventory.write'),
  ('marketing','tenant.products.read'),('marketing','tenant.marketing.write'),
  ('support','tenant.orders.read'),('support','tenant.orders.write'),('support','tenant.customers.read'),('support','tenant.support.write'),
  ('accountant','tenant.orders.read'),('accountant','tenant.finance.read'),('accountant','tenant.reports.read'),
  ('viewer','tenant.products.read'),('viewer','tenant.orders.read'),('viewer','tenant.inventory.read'),('viewer','tenant.reports.read')
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM role_perm rp
JOIN public.roles r ON r.store_id IS NULL AND r.role_type = 'tenant_template' AND r.name = rp.role_name
JOIN public.permissions p ON p.name = rp.perm_name
ON CONFLICT DO NOTHING;

-- Copy tenant.* permissions from templates to existing tenant roles with matching names.
WITH template_map AS (
  SELECT tr.name, rp.permission_id
  FROM public.roles tr
  JOIN public.role_permissions rp ON rp.role_id = tr.id
  JOIN public.permissions p ON p.id = rp.permission_id
  WHERE tr.store_id IS NULL
    AND tr.role_type = 'tenant_template'
    AND p.name LIKE 'tenant.%'
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT tenant_role.id, tm.permission_id
FROM public.roles tenant_role
JOIN template_map tm ON tm.name = tenant_role.name
WHERE tenant_role.store_id IS NOT NULL
  AND tenant_role.role_type = 'tenant'
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Remove legacy JWT app_metadata RLS policies.
-- They can coexist with correct tenant policies and accidentally reopen data.
-- ------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        COALESCE(qual, '') ILIKE '%app_metadata%'
        OR COALESCE(with_check, '') ILIKE '%app_metadata%'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Context-isolated RLS corrections
-- ------------------------------------------------------------
DROP POLICY IF EXISTS permissions_tenant_read ON public.permissions;
DROP POLICY IF EXISTS permissions_authenticated_read_active ON public.permissions;
CREATE POLICY permissions_authenticated_read_active ON public.permissions
FOR SELECT
USING (auth.uid() IS NOT NULL AND COALESCE(is_deprecated, false) = false);

DROP POLICY IF EXISTS roles_tenant_manage ON public.roles;
CREATE POLICY roles_tenant_manage
ON public.roles
FOR ALL
USING (
  store_id IS NOT NULL
  AND role_type = 'tenant'
  AND store_id IN (SELECT public.get_my_stores())
)
WITH CHECK (
  store_id IS NOT NULL
  AND role_type = 'tenant'
  AND store_id IN (SELECT public.get_my_stores())
);

DROP POLICY IF EXISTS role_permissions_tenant_read ON public.role_permissions;
CREATE POLICY role_permissions_tenant_read
ON public.role_permissions
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.roles r
    WHERE r.id = role_id
      AND (
        (r.store_id IS NOT NULL AND r.store_id IN (SELECT public.get_my_stores()))
        OR r.role_type = 'tenant_template'
      )
  )
);

DROP POLICY IF EXISTS user_roles_tenant_manage ON public.user_roles;
CREATE POLICY user_roles_tenant_manage
ON public.user_roles
FOR ALL
USING (
  store_id IN (SELECT public.get_my_stores())
  AND EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = role_id
      AND r.store_id = user_roles.store_id
      AND r.role_type = 'tenant'
  )
)
WITH CHECK (
  store_id IN (SELECT public.get_my_stores())
  AND EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = role_id
      AND r.store_id = user_roles.store_id
      AND r.role_type = 'tenant'
  )
);

INSERT INTO public.system_settings (key, value)
VALUES ('schema_version', '2.5.0-rc2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
