-- RC3 Security Certification hardening for EGParts SaaS
-- Run after 07_production_rc1_hardening.sql and 09_rc2_context_isolation.sql.

BEGIN;

ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stores_status_check' AND conrelid = 'public.stores'::regclass
  ) THEN
    ALTER TABLE public.stores ADD CONSTRAINT stores_status_check
      CHECK (status IN ('active','suspended','expired','deleted','pending'));
  END IF;
END $$;

ALTER TABLE public.site_settings DROP CONSTRAINT IF EXISTS site_settings_store_id_key;
ALTER TABLE public.site_settings ADD CONSTRAINT site_settings_store_id_key UNIQUE (store_id);

CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_domain_unique_idx ON public.custom_domains (lower(domain));
CREATE INDEX IF NOT EXISTS idx_orders_store_created ON public.orders(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_store_status_created ON public.orders(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_store_active_deleted ON public.products(store_id, is_active, is_deleted);
CREATE INDEX IF NOT EXISTS idx_user_login_logs_store_created ON public.user_login_logs(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.otp_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  phone text NOT NULL,
  purpose text NOT NULL DEFAULT 'login',
  status text NOT NULL CHECK (status IN ('sent','failed','verified','rejected')),
  error_message text,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_audit_store_created ON public.otp_audit_logs(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_audit_store_phone_created ON public.otp_audit_logs(store_id, phone, created_at DESC);

ALTER TABLE public.otp_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS otp_audit_tenant_select ON public.otp_audit_logs;
DROP POLICY IF EXISTS otp_audit_platform_all ON public.otp_audit_logs;
CREATE POLICY otp_audit_tenant_select ON public.otp_audit_logs
  FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY otp_audit_platform_all ON public.otp_audit_logs
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

CREATE OR REPLACE FUNCTION public.prune_login_logs(p_keep integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY store_id ORDER BY created_at DESC) AS rn
    FROM public.user_login_logs
  ),
  deleted AS (
    DELETE FROM public.user_login_logs ull
    USING ranked r
    WHERE ull.id = r.id AND r.rn > p_keep
    RETURNING ull.id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_overdue_stores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.stores
  SET is_active = false,
      status = 'expired',
      updated_at = now()
  WHERE subscription_expires_at < now()
    AND status <> 'deleted'
    AND (is_active = true OR status <> 'expired');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

INSERT INTO public.permissions (name, description, version) VALUES
('platform.access','Access platform administration area',3),
('platform.health.read','View platform health dashboard',3),
('platform.tenants.write','Create, suspend, recover, and soft delete tenants',3),
('platform.billing.write','Manage platform billing providers and invoices',3),
('platform.domains.write','Manage custom domain ownership and verification',3),
('platform.notifications.write','Manage platform notification templates',3)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    version = GREATEST(public.permissions.version, EXCLUDED.version),
    is_deprecated = false;

WITH platform_role AS (
  INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, role_type, description)
  VALUES (NULL, 'super_admin', 'Super Administrator', 0, true, false, 'platform', 'Platform owner role')
  ON CONFLICT (store_id, name) DO UPDATE
  SET role_type = 'platform',
      display_name = EXCLUDED.display_name,
      system_role = true,
      editable = false
  RETURNING id
),
platform_perms AS (
  SELECT id FROM public.permissions WHERE name LIKE 'platform.%'
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT platform_role.id, platform_perms.id
FROM platform_role, platform_perms
ON CONFLICT DO NOTHING;

INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, role_type, description)
VALUES (NULL, 'owner', 'Owner', 1, true, false, 'tenant_template', 'Tenant owner with full store administration permissions')
ON CONFLICT (store_id, name) DO UPDATE
SET role_type = 'tenant_template',
    display_name = EXCLUDED.display_name,
    priority = EXCLUDED.priority,
    system_role = true,
    editable = false;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_storage_objects' AND column_name = 'object_key'
  ) THEN
    ALTER TABLE public.platform_storage_objects DROP CONSTRAINT IF EXISTS platform_storage_namespace_check;
    ALTER TABLE public.platform_storage_objects ADD CONSTRAINT platform_storage_namespace_check
      CHECK (
        (scope = 'platform' AND store_id IS NULL AND object_key LIKE 'platform/%')
        OR
        (scope = 'tenant' AND store_id IS NOT NULL AND object_key LIKE ('stores/' || store_id::text || '/%'))
      );
  END IF;
END $$;

INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('schema_version', '3.0.0-rc3-security', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
