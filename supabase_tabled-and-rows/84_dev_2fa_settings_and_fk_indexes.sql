-- 84: Create missing user_2fa_settings table + finish Dev FK index set.
--
-- Why: live authenticated E2E against Dev exposed that public.user_2fa_settings
-- does not exist even though twoFactorService reads/writes it (setup/verify/
-- enable/disable/challenge all fail). No migration in this folder ever created
-- it — it only appeared in remediation lists (49/52), so table audits passed
-- while the feature was broken.
--
-- Also completes the FK indexes from migration 52 that were skipped when their
-- target tables were absent at the time, using per-table existence guards so
-- the file stays idempotent and order-independent.

CREATE TABLE IF NOT EXISTS public.user_2fa_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  store_id uuid NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  method text NOT NULL DEFAULT 'whatsapp',
  totp_secret text,
  totp_verified boolean NOT NULL DEFAULT false,
  backup_codes jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_2fa_settings_user_store_uq
  ON public.user_2fa_settings (user_id, store_id);

-- Internal-only table: deny Data API access for anon/authenticated (pattern of
-- migration 49), backend reaches it through the service role which bypasses RLS.
ALTER TABLE public.user_2fa_settings ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  policy_name text := 'deny_public_api_user_2fa_settings';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = to_regclass('public.user_2fa_settings')
      AND p.polname = policy_name
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.user_2fa_settings FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      policy_name
    );
  END IF;
END $$;

-- Remaining FK indexes (52 follow-up), guarded per table.
DO $$
DECLARE
  idx record;
BEGIN
  FOR idx IN
    SELECT * FROM (VALUES
      ('idx_fk_bundle_capabilities_capability', 'bundle_capabilities', 'capability_id'),
      ('idx_fk_feature_events_feature_definition', 'feature_events', 'feature_definition_id'),
      ('idx_fk_feature_usage_feature_key', 'feature_usage', 'feature_key'),
      ('idx_fk_feature_usage_snapshots_feature_definition', 'feature_usage_snapshots', 'feature_definition_id'),
      ('idx_fk_plan_feature_limits_feature_definition', 'plan_feature_limits', 'feature_definition_id'),
      ('idx_fk_plan_features_feature', 'plan_features', 'feature'),
      ('idx_fk_plan_version_bundles_bundle', 'plan_version_bundles', 'bundle_id'),
      ('idx_fk_plan_version_capabilities_capability', 'plan_version_capabilities', 'capability_id'),
      ('idx_fk_product_stock_shelf', 'product_stock', 'shelf_id'),
      ('idx_fk_role_permissions_permission', 'role_permissions', 'permission_id'),
      ('idx_fk_store_admins_store', 'store_admins', 'store_id'),
      ('idx_fk_store_apps_app', 'store_apps', 'app_id'),
      ('idx_fk_store_staff_user', 'store_staff', 'user_id'),
      ('idx_fk_user_2fa_settings_store', 'user_2fa_settings', 'store_id'),
      ('idx_fk_user_addresses_user', 'user_addresses', 'user_id'),
      ('idx_fk_user_roles_store', 'user_roles', 'store_id'),
      ('idx_fk_wishlists_product', 'wishlists', 'product_id')
    ) AS v(idx_name, tbl_name, col_name)
    WHERE to_regclass(format('public.%I', v.tbl_name)) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = v.idx_name
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = v.tbl_name
          AND column_name = v.col_name
      )
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)',
      idx.idx_name, idx.tbl_name, idx.col_name
    );
  END LOOP;
END $$;
