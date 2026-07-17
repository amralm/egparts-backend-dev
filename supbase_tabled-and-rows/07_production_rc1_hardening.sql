-- ============================================================
-- RC1 Production Hardening Migration
-- Scope:
--   - Complete RLS for tenant, platform, billing, domain, notification, inventory tables
--   - Add missing constraints, indexes, updated_at triggers, feature usage tracking
--   - Seed production RBAC roles, permissions, subscription features, and email templates
--   - Replace checkout RPC with a secure SECURITY DEFINER implementation
-- Run once in Supabase SQL Editor after 01..06 migrations.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- Generic helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
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

CREATE OR REPLACE FUNCTION public.get_my_stores()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
  FROM public.stores s
  WHERE public.is_super_admin()
  UNION
  SELECT sa.store_id
  FROM public.store_admins sa
  WHERE sa.user_id = auth.uid()
  UNION
  SELECT ur.store_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_store_active(p_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.stores s
    WHERE s.id = p_store_id
      AND s.is_active = true
      AND s.subscription_expires_at > now()
  );
$$;

CREATE OR REPLACE FUNCTION public.has_permission(p_permission text, p_store_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
  OR EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND p.name = p_permission
      AND COALESCE(p.is_deprecated, false) = false
      AND (p_store_id IS NULL OR ur.store_id = p_store_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_branch(p_branch_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.store_id FROM public.branches b WHERE b.id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_warehouse(p_warehouse_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.store_id
  FROM public.warehouses w
  JOIN public.branches b ON b.id = w.branch_id
  WHERE w.id = p_warehouse_id;
$$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_shelf(p_shelf_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.store_id
  FROM public.shelves sh
  JOIN public.warehouses w ON w.id = sh.warehouse_id
  JOIN public.branches b ON b.id = w.branch_id
  WHERE sh.id = p_shelf_id;
$$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_product(p_product_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.store_id FROM public.products p WHERE p.id = p_product_id;
$$;

-- ------------------------------------------------------------
-- Missing platform/subscription columns and tables
-- ------------------------------------------------------------
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS trial_days integer DEFAULT 0;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS trial_enabled boolean DEFAULT false;
ALTER TABLE public.store_subscriptions ADD COLUMN IF NOT EXISTS grace_period_days integer NOT NULL DEFAULT 0;
ALTER TABLE public.store_subscriptions ADD COLUMN IF NOT EXISTS renewal_at timestamptz;
ALTER TABLE public.store_subscriptions ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
ALTER TABLE public.tenant_invitations ADD COLUMN IF NOT EXISTS resent_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.tenant_invitations ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS duration_ms integer;

CREATE TABLE IF NOT EXISTS public.system_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feature_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  usage_count bigint NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  period_end timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT feature_usage_store_feature_period_unique UNIQUE (store_id, feature_key, period_start)
);

CREATE TABLE IF NOT EXISTS public.platform_storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('platform', 'tenant')),
  store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  bucket text NOT NULL,
  category text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  content_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'orphaned', 'quarantined')),
  created_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT platform_storage_scope_store_check CHECK (
    (scope = 'platform' AND store_id IS NULL)
    OR (scope = 'tenant' AND store_id IS NOT NULL)
  )
);

-- ------------------------------------------------------------
-- Constraints and indexes
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_admins_user_store_unique') THEN
    ALTER TABLE public.store_admins ADD CONSTRAINT store_admins_user_store_unique UNIQUE (user_id, store_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_payment_gateways_store_provider_unique') THEN
    ALTER TABLE public.store_payment_gateways ADD CONSTRAINT store_payment_gateways_store_provider_unique UNIQUE (store_id, provider_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_store_name_unique') THEN
    ALTER TABLE public.roles ADD CONSTRAINT roles_store_name_unique UNIQUE (store_id, name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_features_plan_feature_unique') THEN
    ALTER TABLE public.plan_features ADD CONSTRAINT plan_features_plan_feature_unique UNIQUE (plan_id, feature_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_limits_plan_feature_type_unique') THEN
    ALTER TABLE public.feature_limits ADD CONSTRAINT feature_limits_plan_feature_type_unique UNIQUE (plan_feature_id, limit_type);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_templates_code_channel_language_unique') THEN
    ALTER TABLE public.notification_templates ADD CONSTRAINT notification_templates_code_channel_language_unique UNIQUE (code, channel, language);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupons_store_code_unique') THEN
    ALTER TABLE public.coupons ADD CONSTRAINT coupons_store_code_unique UNIQUE (store_id, code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_zones_store_city_unique') THEN
    ALTER TABLE public.shipping_zones ADD CONSTRAINT shipping_zones_store_city_unique UNIQUE (store_id, city_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocked_ips_store_ip_unique') THEN
    ALTER TABLE public.blocked_ips ADD CONSTRAINT blocked_ips_store_ip_unique UNIQUE (store_id, ip_address);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_id_store_id_unique') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_id_store_id_unique UNIQUE (id, store_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_id_store_id_unique') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_id_store_id_unique UNIQUE (id, store_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupons_id_store_id_unique') THEN
    ALTER TABLE public.coupons ADD CONSTRAINT coupons_id_store_id_unique UNIQUE (id, store_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_store_idempotency_unique') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_store_idempotency_unique UNIQUE (store_id, idempotency_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_store_order_number_unique') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_store_order_number_unique UNIQUE (store_id, order_number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_stock_product_shelf_batch_unique') THEN
    ALTER TABLE public.product_stock ADD CONSTRAINT product_stock_product_shelf_batch_unique UNIQUE (product_id, shelf_id, batch_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stores_subdomain_active ON public.stores(subdomain, is_active);
CREATE INDEX IF NOT EXISTS idx_stores_custom_domain_active ON public.stores(custom_domain, is_active);
CREATE INDEX IF NOT EXISTS idx_products_store_active ON public.products(store_id, is_active, is_deleted);
CREATE INDEX IF NOT EXISTS idx_products_store_category ON public.products(store_id, category);
CREATE INDEX IF NOT EXISTS idx_orders_store_created ON public.orders(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_store ON public.orders(user_id, store_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_store ON public.order_items(order_id, store_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_store_status ON public.reviews(product_id, store_id, status);
CREATE INDEX IF NOT EXISTS idx_user_profiles_store_user ON public.user_profiles(store_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_store_phone ON public.user_profiles(store_id, phone);
CREATE INDEX IF NOT EXISTS idx_wishlists_user_store ON public.wishlists(user_id, store_id);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status_retry ON public.notification_queue(status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_store_created ON public.audit_logs(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON public.audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_domains_store ON public.custom_domains(store_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON public.custom_domains(domain);
CREATE INDEX IF NOT EXISTS idx_invoices_store_status ON public.invoices(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON public.payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_invoice ON public.payment_transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_domain_health_checks_domain_time ON public.domain_health_checks(domain_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_feature_usage_store_feature ON public.feature_usage(store_id, feature_key, period_start);
CREATE INDEX IF NOT EXISTS idx_platform_storage_store_status ON public.platform_storage_objects(store_id, status);

-- updated_at triggers
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores','store_payment_gateways','store_subscriptions','tenant_invitations',
    'system_settings','feature_usage','custom_domains','invoices','notification_layouts',
    'notification_templates','payment_providers','payment_transactions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Enable RLS on every public application table
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products','orders','reviews','site_settings','coupons','user_profiles','shipping_zones',
    'wishlists','order_tracking','user_notifications','banners','product_views','otp_codes',
    'user_addresses','whatsapp_sessions','notification_queue','order_logs','order_items',
    'inventory_adjustments','user_login_logs','blocked_ips','stores','store_admins',
    'super_admins','store_payment_gateways','store_counters','impersonation_logs',
    'permissions','roles','role_permissions','user_roles','plans','features','plan_features',
    'feature_limits','store_subscriptions','tenant_invitations','audit_logs','branches',
    'warehouses','shelves','product_batches','product_stock','custom_domains','invoices',
    'invoice_items','payments','refunds','notification_layouts','notification_templates',
    'notification_history','payment_providers','payment_transactions','domain_health_checks',
    'system_settings','feature_usage','platform_storage_objects'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- RLS policies
-- ------------------------------------------------------------
DROP POLICY IF EXISTS stores_public_active_select ON public.stores;
DROP POLICY IF EXISTS stores_admin_select ON public.stores;
DROP POLICY IF EXISTS stores_super_admin_all ON public.stores;
CREATE POLICY stores_public_active_select ON public.stores FOR SELECT USING (is_active = true AND subscription_expires_at > now());
CREATE POLICY stores_admin_select ON public.stores FOR SELECT USING (id IN (SELECT public.get_my_stores()));
CREATE POLICY stores_super_admin_all ON public.stores FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS store_admins_self_select ON public.store_admins;
DROP POLICY IF EXISTS store_admins_super_admin_all ON public.store_admins;
CREATE POLICY store_admins_self_select ON public.store_admins FOR SELECT USING (user_id = auth.uid() OR store_id IN (SELECT public.get_my_stores()));
CREATE POLICY store_admins_super_admin_all ON public.store_admins FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS super_admins_self_select ON public.super_admins;
DROP POLICY IF EXISTS super_admins_super_admin_all ON public.super_admins;
CREATE POLICY super_admins_self_select ON public.super_admins FOR SELECT USING (user_id = auth.uid());
CREATE POLICY super_admins_super_admin_all ON public.super_admins FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS products_public_select ON public.products;
DROP POLICY IF EXISTS products_admin_all ON public.products;
CREATE POLICY products_public_select ON public.products FOR SELECT USING (public.is_store_active(store_id) AND is_active = true AND COALESCE(is_deleted, false) = false);
CREATE POLICY products_admin_all ON public.products FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS orders_customer_select ON public.orders;
DROP POLICY IF EXISTS orders_admin_all ON public.orders;
CREATE POLICY orders_customer_select ON public.orders FOR SELECT USING (user_id = auth.uid() AND public.is_store_active(store_id));
CREATE POLICY orders_admin_all ON public.orders FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS order_items_customer_select ON public.order_items;
DROP POLICY IF EXISTS order_items_admin_all ON public.order_items;
CREATE POLICY order_items_customer_select ON public.order_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid() AND o.store_id = store_id)
);
CREATE POLICY order_items_admin_all ON public.order_items FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS reviews_public_select ON public.reviews;
DROP POLICY IF EXISTS reviews_public_insert ON public.reviews;
DROP POLICY IF EXISTS reviews_admin_all ON public.reviews;
CREATE POLICY reviews_public_select ON public.reviews FOR SELECT USING (status = 'approved' AND public.is_store_active(store_id));
CREATE POLICY reviews_public_insert ON public.reviews FOR INSERT WITH CHECK (
  status = 'pending' AND rating BETWEEN 1 AND 5 AND length(user_name) >= 2 AND length(comment) >= 5 AND public.is_store_active(store_id)
);
CREATE POLICY reviews_admin_all ON public.reviews FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS site_settings_public_select ON public.site_settings;
DROP POLICY IF EXISTS site_settings_admin_all ON public.site_settings;
CREATE POLICY site_settings_public_select ON public.site_settings FOR SELECT USING (public.is_store_active(store_id));
CREATE POLICY site_settings_admin_all ON public.site_settings FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS coupons_public_select ON public.coupons;
DROP POLICY IF EXISTS coupons_admin_all ON public.coupons;
CREATE POLICY coupons_public_select ON public.coupons FOR SELECT USING (
  is_active = true AND public.is_store_active(store_id)
  AND (expiry_date IS NULL OR expiry_date > now())
);
CREATE POLICY coupons_admin_all ON public.coupons FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS profiles_self_all ON public.user_profiles;
DROP POLICY IF EXISTS profiles_admin_all ON public.user_profiles;
CREATE POLICY profiles_self_all ON public.user_profiles FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY profiles_admin_all ON public.user_profiles FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS shipping_public_select ON public.shipping_zones;
DROP POLICY IF EXISTS shipping_admin_all ON public.shipping_zones;
CREATE POLICY shipping_public_select ON public.shipping_zones FOR SELECT USING (is_active = true AND public.is_store_active(store_id));
CREATE POLICY shipping_admin_all ON public.shipping_zones FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS wishlists_self_all ON public.wishlists;
DROP POLICY IF EXISTS wishlists_admin_select ON public.wishlists;
CREATE POLICY wishlists_self_all ON public.wishlists FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY wishlists_admin_select ON public.wishlists FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS order_tracking_customer_select ON public.order_tracking;
DROP POLICY IF EXISTS order_tracking_admin_all ON public.order_tracking;
CREATE POLICY order_tracking_customer_select ON public.order_tracking FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid() AND o.store_id = store_id)
);
CREATE POLICY order_tracking_admin_all ON public.order_tracking FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS notifications_self_select ON public.user_notifications;
DROP POLICY IF EXISTS notifications_self_update ON public.user_notifications;
DROP POLICY IF EXISTS notifications_admin_all ON public.user_notifications;
CREATE POLICY notifications_self_select ON public.user_notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY notifications_self_update ON public.user_notifications FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY notifications_admin_all ON public.user_notifications FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS banners_public_select ON public.banners;
DROP POLICY IF EXISTS banners_admin_all ON public.banners;
CREATE POLICY banners_public_select ON public.banners FOR SELECT USING (is_active = true AND public.is_store_active(store_id));
CREATE POLICY banners_admin_all ON public.banners FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS product_views_public_insert ON public.product_views;
DROP POLICY IF EXISTS product_views_admin_select ON public.product_views;
CREATE POLICY product_views_public_insert ON public.product_views FOR INSERT WITH CHECK (public.is_store_active(store_id));
CREATE POLICY product_views_admin_select ON public.product_views FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS addresses_self_all ON public.user_addresses;
DROP POLICY IF EXISTS addresses_admin_select ON public.user_addresses;
CREATE POLICY addresses_self_all ON public.user_addresses FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY addresses_admin_select ON public.user_addresses FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));

-- Service-only tables: no public policies. Super admin may inspect platform operational data.
DROP POLICY IF EXISTS otp_codes_super_admin_select ON public.otp_codes;
DROP POLICY IF EXISTS whatsapp_sessions_super_admin_select ON public.whatsapp_sessions;
DROP POLICY IF EXISTS notification_queue_super_admin_all ON public.notification_queue;
CREATE POLICY otp_codes_super_admin_select ON public.otp_codes FOR SELECT USING (public.is_super_admin());
CREATE POLICY whatsapp_sessions_super_admin_select ON public.whatsapp_sessions FOR SELECT USING (public.is_super_admin());
CREATE POLICY notification_queue_super_admin_all ON public.notification_queue FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS order_logs_admin_all ON public.order_logs;
DROP POLICY IF EXISTS inventory_adjustments_admin_all ON public.inventory_adjustments;
DROP POLICY IF EXISTS login_logs_insert_self ON public.user_login_logs;
DROP POLICY IF EXISTS login_logs_admin_select ON public.user_login_logs;
DROP POLICY IF EXISTS blocked_ips_admin_all ON public.blocked_ips;
CREATE POLICY order_logs_admin_all ON public.order_logs FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY inventory_adjustments_admin_all ON public.inventory_adjustments FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY login_logs_insert_self ON public.user_login_logs FOR INSERT WITH CHECK (user_id IS NULL OR user_id = auth.uid());
CREATE POLICY login_logs_admin_select ON public.user_login_logs FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY blocked_ips_admin_all ON public.blocked_ips FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

DROP POLICY IF EXISTS store_gateways_admin_all ON public.store_payment_gateways;
DROP POLICY IF EXISTS store_counters_admin_select ON public.store_counters;
DROP POLICY IF EXISTS impersonation_super_admin_all ON public.impersonation_logs;
CREATE POLICY store_gateways_admin_all ON public.store_payment_gateways FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY store_counters_admin_select ON public.store_counters FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY impersonation_super_admin_all ON public.impersonation_logs FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- RBAC policies
DROP POLICY IF EXISTS permissions_super_admin_all ON public.permissions;
DROP POLICY IF EXISTS permissions_tenant_read ON public.permissions;
DROP POLICY IF EXISTS roles_super_admin_all ON public.roles;
DROP POLICY IF EXISTS roles_tenant_read ON public.roles;
DROP POLICY IF EXISTS roles_tenant_manage ON public.roles;
DROP POLICY IF EXISTS role_permissions_super_admin_all ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_tenant_read ON public.role_permissions;
DROP POLICY IF EXISTS user_roles_super_admin_all ON public.user_roles;
DROP POLICY IF EXISTS user_roles_self_read ON public.user_roles;
DROP POLICY IF EXISTS user_roles_tenant_manage ON public.user_roles;
CREATE POLICY permissions_super_admin_all ON public.permissions FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
CREATE POLICY permissions_tenant_read ON public.permissions FOR SELECT USING (true);
CREATE POLICY roles_super_admin_all ON public.roles FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
CREATE POLICY roles_tenant_read ON public.roles FOR SELECT USING (store_id IN (SELECT public.get_my_stores()) OR role_type = 'tenant_template');
CREATE POLICY roles_tenant_manage ON public.roles FOR ALL USING (store_id IN (SELECT public.get_my_stores()) AND role_type = 'tenant') WITH CHECK (store_id IN (SELECT public.get_my_stores()) AND role_type = 'tenant');
CREATE POLICY role_permissions_super_admin_all ON public.role_permissions FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
CREATE POLICY role_permissions_tenant_read ON public.role_permissions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.roles r WHERE r.id = role_id AND (r.store_id IN (SELECT public.get_my_stores()) OR r.role_type = 'tenant_template'))
);
CREATE POLICY user_roles_super_admin_all ON public.user_roles FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
CREATE POLICY user_roles_self_read ON public.user_roles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY user_roles_tenant_manage ON public.user_roles FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));

-- Platform-only SaaS/billing/configuration policies
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'plans','features','plan_features','feature_limits','store_subscriptions',
    'tenant_invitations','audit_logs','system_settings','custom_domains',
    'invoices','invoice_items','payments','refunds','notification_layouts',
    'notification_templates','notification_history','payment_providers',
    'payment_transactions','domain_health_checks','platform_storage_objects'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_super_admin_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())', t || '_super_admin_all', t);
  END LOOP;
END $$;

-- Tenant branch/inventory policies
DROP POLICY IF EXISTS branches_admin_all ON public.branches;
DROP POLICY IF EXISTS warehouses_admin_all ON public.warehouses;
DROP POLICY IF EXISTS shelves_admin_all ON public.shelves;
DROP POLICY IF EXISTS batches_admin_all ON public.product_batches;
DROP POLICY IF EXISTS stock_admin_all ON public.product_stock;
CREATE POLICY branches_admin_all ON public.branches FOR ALL USING (store_id IN (SELECT public.get_my_stores())) WITH CHECK (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY warehouses_admin_all ON public.warehouses FOR ALL USING (public.row_store_id_from_branch(branch_id) IN (SELECT public.get_my_stores())) WITH CHECK (public.row_store_id_from_branch(branch_id) IN (SELECT public.get_my_stores()));
CREATE POLICY shelves_admin_all ON public.shelves FOR ALL USING (public.row_store_id_from_warehouse(warehouse_id) IN (SELECT public.get_my_stores())) WITH CHECK (public.row_store_id_from_warehouse(warehouse_id) IN (SELECT public.get_my_stores()));
CREATE POLICY batches_admin_all ON public.product_batches FOR ALL USING (public.row_store_id_from_product(product_id) IN (SELECT public.get_my_stores())) WITH CHECK (public.row_store_id_from_product(product_id) IN (SELECT public.get_my_stores()));
CREATE POLICY stock_admin_all ON public.product_stock FOR ALL USING (
  public.row_store_id_from_product(product_id) IN (SELECT public.get_my_stores())
  AND public.row_store_id_from_shelf(shelf_id) IN (SELECT public.get_my_stores())
) WITH CHECK (
  public.row_store_id_from_product(product_id) IN (SELECT public.get_my_stores())
  AND public.row_store_id_from_shelf(shelf_id) IN (SELECT public.get_my_stores())
);

DROP POLICY IF EXISTS feature_usage_admin_select ON public.feature_usage;
DROP POLICY IF EXISTS feature_usage_super_admin_all ON public.feature_usage;
CREATE POLICY feature_usage_admin_select ON public.feature_usage FOR SELECT USING (store_id IN (SELECT public.get_my_stores()));
CREATE POLICY feature_usage_super_admin_all ON public.feature_usage FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ------------------------------------------------------------
-- Secure checkout RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_user_id uuid,
  p_items jsonb,
  p_phone text,
  p_city text,
  p_address text,
  p_customer_note text DEFAULT '',
  p_payment_method text DEFAULT 'cod',
  p_coupon_code text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_auth_source text DEFAULT 'otp',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_store_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_item jsonb;
  v_order_number bigint;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_coupon_id uuid := NULL;
  v_shipping_fee numeric := 0;
  v_total numeric := 0;
  v_product record;
  v_coupon record;
  v_qty integer;
BEGIN
  IF p_store_id IS NULL OR NOT public.is_store_active(p_store_id) THEN
    RAISE EXCEPTION 'Store is not active';
  END IF;

  IF p_payment_method NOT IN ('cod', 'card', 'cash_on_delivery') THEN
    RAISE EXCEPTION 'Unsupported payment method';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  IF p_phone IS NULL OR length(trim(p_phone)) < 8 OR p_city IS NULL OR p_address IS NULL OR length(trim(p_address)) < 2 THEN
    RAISE EXCEPTION 'Delivery data is incomplete';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM public.orders
    WHERE idempotency_key = p_idempotency_key AND store_id = p_store_id;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', v_order_id, 'success', true, 'status', 'already_exists');
    END IF;
  END IF;

  INSERT INTO public.store_counters (store_id, last_order_number)
  VALUES (p_store_id, 0)
  ON CONFLICT (store_id) DO NOTHING;

  SELECT last_order_number + 1 INTO v_order_number
  FROM public.store_counters
  WHERE store_id = p_store_id
  FOR UPDATE;

  UPDATE public.store_counters
  SET last_order_number = v_order_number
  WHERE store_id = p_store_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'qty')::integer, 0);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'Invalid item quantity';
    END IF;

    SELECT id, name, price, stock_quantity, is_active, COALESCE(is_deleted, false) AS is_deleted
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found';
    END IF;
    IF v_product.is_active IS FALSE OR v_product.is_deleted IS TRUE THEN
      RAISE EXCEPTION 'Product is unavailable: %', v_product.name;
    END IF;
    IF COALESCE(v_product.stock_quantity, 0) < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for product: %', v_product.name;
    END IF;

    v_subtotal := v_subtotal + (COALESCE(v_product.price, 0) * v_qty);
  END LOOP;

  IF p_coupon_code IS NOT NULL AND length(trim(p_coupon_code)) > 0 THEN
    SELECT *
    INTO v_coupon
    FROM public.coupons
    WHERE upper(code) = upper(trim(p_coupon_code))
      AND store_id = p_store_id
      AND is_active = true
    FOR UPDATE;

    IF FOUND THEN
      IF (v_coupon.expiry_date IS NULL OR v_coupon.expiry_date > now())
        AND COALESCE(v_coupon.used_count, 0) < COALESCE(NULLIF(v_coupon.max_uses, 0), 2147483647)
        AND v_subtotal >= COALESCE(v_coupon.min_order_value, 0)
      THEN
        v_coupon_id := v_coupon.id;
        v_discount := CASE
          WHEN COALESCE(v_coupon.discount_percentage, 0) > 0 THEN v_subtotal * (v_coupon.discount_percentage / 100)
          ELSE COALESCE(v_coupon.discount_amount, 0)
        END;
        v_discount := LEAST(v_discount, v_subtotal);
        UPDATE public.coupons SET used_count = COALESCE(used_count, 0) + 1 WHERE id = v_coupon.id;
      END IF;
    END IF;
  END IF;

  SELECT shipping_fee
  INTO v_shipping_fee
  FROM public.shipping_zones
  WHERE store_id = p_store_id AND city_name = p_city AND is_active = true
  LIMIT 1;

  IF v_shipping_fee IS NULL THEN
    SELECT shipping_fee
    INTO v_shipping_fee
    FROM public.shipping_zones
    WHERE store_id = p_store_id AND city_name IN ('محافظة أخرى', 'Other') AND is_active = true
    LIMIT 1;
  END IF;

  v_shipping_fee := COALESCE(v_shipping_fee, 0);

  IF EXISTS (
    SELECT 1
    FROM public.site_settings ss
    WHERE ss.store_id = p_store_id
      AND COALESCE(ss.free_shipping_enabled, true) = true
      AND v_subtotal >= COALESCE(ss.free_shipping_threshold, 0)
  ) THEN
    v_shipping_fee := 0;
  END IF;

  v_total := GREATEST(v_subtotal + v_shipping_fee - v_discount, 0);

  INSERT INTO public.orders (
    user_id, phone, city, address, customer_note, payment_method,
    subtotal, discount, discount_amount, shipping_fee, total, total_amount,
    coupon_id, idempotency_key, order_number, status, payment_status,
    auth_source, metadata, items, store_id
  )
  VALUES (
    p_user_id, p_phone, p_city, p_address, COALESCE(p_customer_note, ''), p_payment_method,
    v_subtotal, v_discount, v_discount, v_shipping_fee, v_total, v_total,
    v_coupon_id, p_idempotency_key, v_order_number, 'pending',
    CASE WHEN p_payment_method = 'cod' OR p_payment_method = 'cash_on_delivery' THEN 'unpaid' ELSE 'pending' END,
    p_auth_source, COALESCE(p_metadata, '{}'::jsonb), p_items, p_store_id
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'qty')::integer;

    SELECT id, name, price
    INTO v_product
    FROM public.products
    WHERE id = (v_item->>'id')::uuid AND store_id = p_store_id;

    UPDATE public.products
    SET stock_quantity = stock_quantity - v_qty,
        stock = GREATEST(COALESCE(stock, stock_quantity) - v_qty, 0)
    WHERE id = v_product.id AND store_id = p_store_id AND stock_quantity >= v_qty;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock update failed';
    END IF;

    INSERT INTO public.order_items (order_id, product_id, title, quantity, unit_price, store_id)
    VALUES (v_order_id, v_product.id, v_product.name, v_qty, v_product.price, p_store_id);

    INSERT INTO public.inventory_adjustments (product_id, order_id, admin_id, change_amount, reason, store_id)
    VALUES (v_product.id, v_order_id, NULL, -v_qty, 'sale', p_store_id);
  END LOOP;

  INSERT INTO public.order_tracking (order_id, status, note, store_id)
  VALUES (v_order_id, 'pending', 'Order created', p_store_id);

  RETURN jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number::text,
    'subtotal', v_subtotal,
    'shipping_fee', v_shipping_fee,
    'discount', v_discount,
    'total', v_total,
    'success', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_atomic(uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(uuid, jsonb, text, text, text, text, text, text, text, text, jsonb, uuid) TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Seed RBAC permissions, staff role templates, plans, features
-- ------------------------------------------------------------
INSERT INTO public.permissions (name, description, version) VALUES
('platform.health.read','View platform health dashboard',1),
('platform.settings.write','Manage platform settings',1),
('platform.tenants.write','Create, suspend, recover, delete tenants',1),
('platform.plans.write','Manage SaaS plans and limits',1),
('platform.billing.write','Manage invoices, payments, refunds, subscriptions',1),
('platform.domains.write','Manage custom domains and domain verification',1),
('platform.notifications.write','Manage global notification layouts and templates',1),
('platform.audit.read','Read all platform audit logs',1),
('platform.storage.write','Manage platform storage assets',1),
('products.read','Read products',1),
('products.write','Create and update products',1),
('products.delete','Delete or archive products',1),
('orders.read','Read orders',1),
('orders.write','Update orders',1),
('inventory.read','Read inventory',1),
('inventory.write','Adjust inventory',1),
('branches.manage','Manage branches, warehouses, shelves',1),
('customers.read','Read customers',1),
('customers.write','Update customer profiles',1),
('marketing.write','Manage banners, reviews, content, coupons',1),
('settings.write','Manage tenant settings',1),
('reports.read','Read reports and dashboard metrics',1),
('support.write','Manage reviews, support and tracking',1),
('finance.read','Read financial data',1)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, version = EXCLUDED.version;

WITH role_seed(store_id, name, display_name, priority, system_role, editable, role_type, description) AS (
  VALUES
  (NULL::uuid,'super_admin','Platform Owner',0,true,false,'platform','Owns and manages the full SaaS platform'),
  (NULL::uuid,'owner','Owner',1,true,false,'tenant_template','Full tenant ownership'),
  (NULL::uuid,'admin','Admin',2,true,true,'tenant_template','Tenant administration'),
  (NULL::uuid,'manager','Manager',3,true,true,'tenant_template','Operational management'),
  (NULL::uuid,'sales','Sales',4,true,true,'tenant_template','Sales operations'),
  (NULL::uuid,'cashier','Cashier',5,true,true,'tenant_template','Checkout and order processing'),
  (NULL::uuid,'inventory','Inventory',6,true,true,'tenant_template','Product inventory management'),
  (NULL::uuid,'warehouse','Warehouse',7,true,true,'tenant_template','Warehouse and shelf operations'),
  (NULL::uuid,'purchasing','Purchasing',8,true,true,'tenant_template','Purchasing and supplier operations'),
  (NULL::uuid,'marketing','Marketing',9,true,true,'tenant_template','Marketing content and coupons'),
  (NULL::uuid,'support','Support',10,true,true,'tenant_template','Customer support operations'),
  (NULL::uuid,'accountant','Accountant',11,true,true,'tenant_template','Financial review'),
  (NULL::uuid,'viewer','Viewer',99,true,false,'tenant_template','Read-only tenant access')
), updated AS (
  UPDATE public.roles r
  SET display_name = rs.display_name,
      priority = rs.priority,
      system_role = rs.system_role,
      editable = rs.editable,
      role_type = rs.role_type,
      description = rs.description
  FROM role_seed rs
  WHERE r.store_id IS NULL AND r.name = rs.name
  RETURNING r.name
)
INSERT INTO public.roles (store_id, name, display_name, priority, system_role, editable, role_type, description)
SELECT rs.store_id, rs.name, rs.display_name, rs.priority, rs.system_role, rs.editable, rs.role_type, rs.description
FROM role_seed rs
WHERE NOT EXISTS (
  SELECT 1 FROM public.roles r WHERE r.store_id IS NULL AND r.name = rs.name
);

WITH super_role AS (
  SELECT id FROM public.roles WHERE store_id IS NULL AND name = 'super_admin'
), platform_perms AS (
  SELECT id FROM public.permissions WHERE name LIKE 'platform.%'
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT super_role.id, platform_perms.id FROM super_role, platform_perms
ON CONFLICT DO NOTHING;

WITH owner_role AS (
  SELECT id FROM public.roles WHERE store_id IS NULL AND name IN ('owner','admin')
), tenant_perms AS (
  SELECT id FROM public.permissions WHERE name NOT LIKE 'platform.%'
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT owner_role.id, tenant_perms.id FROM owner_role, tenant_perms
ON CONFLICT DO NOTHING;

WITH role_perm(role_name, perm_name) AS (
  VALUES
  ('manager','products.read'),('manager','orders.read'),('manager','orders.write'),('manager','inventory.read'),('manager','customers.read'),('manager','reports.read'),
  ('sales','products.read'),('sales','orders.read'),('sales','orders.write'),('sales','customers.read'),
  ('cashier','products.read'),('cashier','orders.read'),('cashier','orders.write'),
  ('inventory','products.read'),('inventory','products.write'),('inventory','inventory.read'),('inventory','inventory.write'),
  ('warehouse','inventory.read'),('warehouse','inventory.write'),('warehouse','branches.manage'),
  ('purchasing','products.read'),('purchasing','inventory.read'),('purchasing','inventory.write'),
  ('marketing','products.read'),('marketing','marketing.write'),
  ('support','orders.read'),('support','orders.write'),('support','customers.read'),('support','support.write'),
  ('accountant','orders.read'),('accountant','finance.read'),('accountant','reports.read'),
  ('viewer','products.read'),('viewer','orders.read'),('viewer','inventory.read'),('viewer','reports.read')
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM role_perm rp
JOIN public.roles r ON r.store_id IS NULL AND r.name = rp.role_name
JOIN public.permissions p ON p.name = rp.perm_name
ON CONFLICT DO NOTHING;

INSERT INTO public.features (key, display_name, description) VALUES
('products','Products','Product catalog management'),
('orders','Orders','Order management'),
('branches','Branches','Multi-branch inventory'),
('warehouses','Warehouses','Warehouse and shelf tracking'),
('whatsapp_notifications','WhatsApp Notifications','WhatsApp order and system notifications'),
('custom_domain','Custom Domain','Tenant custom domain support'),
('r2_storage','R2 Storage','Tenant media and document storage'),
('staff_users','Staff Users','Tenant staff accounts'),
('coupons','Coupons','Discount and coupon management'),
('platform_billing','Platform Billing','Subscription billing')
ON CONFLICT (key) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description;

INSERT INTO public.plans (code, display_name, sort_order, is_public, is_default, description, price_monthly, price_yearly, trial_days, trial_enabled, is_system) VALUES
('starter','Starter',1,true,true,'Launch plan for small stores',0,0,14,true,false),
('growth','Growth',2,true,false,'Growing store plan',499,4990,14,true,false),
('scale','Scale',3,true,false,'Multi-branch scaling plan',1499,14990,14,true,false),
('enterprise','Enterprise',4,false,false,'Custom enterprise plan',0,0,0,false,true)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  is_public = EXCLUDED.is_public,
  is_default = EXCLUDED.is_default,
  description = EXCLUDED.description,
  price_monthly = EXCLUDED.price_monthly,
  price_yearly = EXCLUDED.price_yearly,
  trial_days = EXCLUDED.trial_days,
  trial_enabled = EXCLUDED.trial_enabled,
  is_system = EXCLUDED.is_system;

WITH pf AS (
  SELECT p.id AS plan_id, f.id AS feature_id
  FROM public.plans p
  CROSS JOIN public.features f
  WHERE p.code IN ('starter','growth','scale','enterprise')
)
INSERT INTO public.plan_features (plan_id, feature_id)
SELECT plan_id, feature_id FROM pf
ON CONFLICT (plan_id, feature_id) DO NOTHING;

WITH limit_seed(plan_code, feature_key, limit_type, limit_config) AS (
  VALUES
  ('starter','products','count','{"max_value":100}'::jsonb),
  ('starter','staff_users','count','{"max_value":2}'::jsonb),
  ('starter','branches','count','{"max_value":1}'::jsonb),
  ('growth','products','count','{"max_value":1000}'::jsonb),
  ('growth','staff_users','count','{"max_value":10}'::jsonb),
  ('growth','branches','count','{"max_value":3}'::jsonb),
  ('scale','products','count','{"max_value":10000}'::jsonb),
  ('scale','staff_users','count','{"max_value":50}'::jsonb),
  ('scale','branches','count','{"max_value":25}'::jsonb),
  ('enterprise','products','count','{"max_value":-1}'::jsonb),
  ('enterprise','staff_users','count','{"max_value":-1}'::jsonb),
  ('enterprise','branches','count','{"max_value":-1}'::jsonb)
)
INSERT INTO public.feature_limits (plan_feature_id, limit_type, limit_config)
SELECT pf.id, ls.limit_type, ls.limit_config
FROM limit_seed ls
JOIN public.plans p ON p.code = ls.plan_code
JOIN public.features f ON f.key = ls.feature_key
JOIN public.plan_features pf ON pf.plan_id = p.id AND pf.feature_id = f.id
ON CONFLICT (plan_feature_id, limit_type) DO UPDATE SET limit_config = EXCLUDED.limit_config;

INSERT INTO public.system_settings (key, value) VALUES
('schema_version','2.5.0-rc1'),
('maintenance_mode','false'),
('default_trial_days','14'),
('platform_name','EG-PARTS Cloud'),
('primary_domain','egparts.store')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Production notification templates
INSERT INTO public.notification_layouts (name, header_html, footer_html, css) VALUES
('default_email','<div style="padding:20px 0;font-weight:700;font-size:20px">EG-PARTS Cloud</div>','<div style="padding:20px 0;color:#666;font-size:12px">This message was sent by EG-PARTS Cloud.</div>','body{font-family:Arial,sans-serif;color:#111}.button{background:#dc2626;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block}')
ON CONFLICT (name) DO UPDATE SET header_html = EXCLUDED.header_html, footer_html = EXCLUDED.footer_html, css = EXCLUDED.css, updated_at = now();

WITH layout AS (SELECT id FROM public.notification_layouts WHERE name = 'default_email')
INSERT INTO public.notification_templates (code, channel, language, subject, body_html, body_text, layout_id, version, is_active)
SELECT v.code, 'email', 'en', v.subject, v.body_html, v.body_text, layout.id, 1, true
FROM layout, (VALUES
('tenant_invitation','You are invited to EG-PARTS Cloud','<p>Hello,</p><p>You were invited to activate your store account.</p><p><a class="button" href="{{activation_link}}">Accept invitation</a></p><p>This invitation expires in {{expires_hours}} hours.</p>','Accept your invitation: {{activation_link}}'),
('reset_password','Reset your password','<p>Use this secure flow to reset your password.</p>','Reset your password.'),
('verification','Verify your account','<p>Your verification code is {{code}}.</p>','Your verification code is {{code}}.'),
('welcome','Welcome to EG-PARTS Cloud','<p>Welcome {{name}}. Your store is ready.</p>','Welcome {{name}}.'),
('subscription','Subscription update','<p>Your subscription status is {{status}}.</p>','Subscription status: {{status}}'),
('trial_ending','Your trial is ending soon','<p>Your trial ends on {{trial_end}}.</p>','Your trial ends on {{trial_end}}.'),
('invoice','Invoice notification','<p>Invoice {{invoice_number}} total is {{total}} {{currency}}.</p>','Invoice {{invoice_number}} total: {{total}} {{currency}}.'),
('system_notification','System notification','<p>{{message}}</p>','{{message}}')
) AS v(code, subject, body_html, body_text)
ON CONFLICT (code, channel, language) DO UPDATE SET
  subject = EXCLUDED.subject,
  body_html = EXCLUDED.body_html,
  body_text = EXCLUDED.body_text,
  layout_id = EXCLUDED.layout_id,
  is_active = true,
  updated_at = now();

COMMIT;
