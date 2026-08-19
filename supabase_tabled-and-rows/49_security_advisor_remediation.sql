-- Production security/performance remediation.
-- Internal tables remain available to the backend service role, but are not
-- exposed to anon/authenticated through the Supabase Data API.

DO $$
DECLARE
  table_name text;
  policy_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'addon_catalog', 'analytics_events', 'bundle_capabilities', 'bundles',
    'capabilities', 'cost_metrics', 'entitlement_decisions', 'feature_categories',
    'feature_definitions', 'feature_events', 'feature_reservations',
    'feature_usage_snapshots', 'oauth_exchanges', 'payment_intent_transactions',
    'plan_feature_limits', 'plan_version_bundles', 'plan_version_capabilities',
    'plan_versions', 'plan_versions_v2', 'platform_events', 'store_addons',
    'store_addons_v2', 'store_feature_overrides', 'store_feature_overrides_v2',
    'usage_snapshots', 'user_2fa_settings', 'user_global_phones'
  ] LOOP
    policy_name := 'deny_public_api_' || table_name;
    IF to_regclass('public.' || table_name) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_policy p
         WHERE p.polrelid = to_regclass('public.' || table_name)
           AND p.polname = policy_name
       ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        policy_name, table_name
      );
    END IF;
  END LOOP;
END $$;

-- Make all public functions deterministic against search_path hijacking.
ALTER FUNCTION public.check_unique_phone_per_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_expired_oauth_exchanges() SET search_path = public, pg_temp;
ALTER FUNCTION public.commit_feature_usage(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.enforce_feature_limit_trigger() SET search_path = public, pg_temp;
ALTER FUNCTION public.fetch_next_notification_jobs(integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_auth_user_by_email(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_email_by_phone_and_password(text, text, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_product_sales_today(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_table_columns(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_order_notification() SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_order_status_notification() SET search_path = public, pg_temp;
ALTER FUNCTION public.infer_feature_period_type(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_order_status_change() SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_order_status_change() SET search_path = public, pg_temp;
ALTER FUNCTION public.on_store_created_setup_roles() SET search_path = public, pg_temp;
ALTER FUNCTION public.protect_user_profiles() SET search_path = public, pg_temp;
ALTER FUNCTION public.rate_limit_orders() SET search_path = public, pg_temp;
ALTER FUNCTION public.reduce_stock_on_order() SET search_path = public, pg_temp;
ALTER FUNCTION public.reserve_feature_usage(uuid, text, integer, text, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.rollback_feature_usage(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.start_impersonation(uuid, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.stop_impersonation(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_store_admins() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_store_counter() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_store_image_usage(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_sync_banner_image_usage() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_sync_product_image_usage() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_sync_settings_image_usage() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_last_active() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;

-- Remove only confirmed duplicate indexes; constraints and one canonical index
-- for each key remain intact.
ALTER TABLE public.feature_limits DROP CONSTRAINT IF EXISTS feature_limits_plan_feature_type_unique;
ALTER TABLE public.notification_templates DROP CONSTRAINT IF EXISTS template_code_channel_lang;
DROP INDEX IF EXISTS public.idx_order_items_order_id;
ALTER TABLE public.plan_features DROP CONSTRAINT IF EXISTS plan_features_plan_feature_unique;
ALTER TABLE public.product_stock DROP CONSTRAINT IF EXISTS product_stock_product_shelf_batch_unique;
DROP INDEX IF EXISTS public.idx_products_store_active_deleted;
ALTER TABLE public.roles DROP CONSTRAINT IF EXISTS store_role_unique;
ALTER TABLE public.store_admins DROP CONSTRAINT IF EXISTS store_admins_user_store_unique;
ALTER TABLE public.store_payment_gateways DROP CONSTRAINT IF EXISTS store_payment_gateways_store_provider_unique;

COMMENT ON POLICY deny_public_api_addon_catalog ON public.addon_catalog IS
  'Internal catalog; access only through the backend service role.';
