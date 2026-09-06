-- 101_platform_storage_metrics.sql
-- Fast, secure platform storage diagnostics function for Super Admin
-- Queries Postgres internal catalogs and tenant aggregates with zero impact on runtime performance.

CREATE OR REPLACE FUNCTION public.get_platform_storage_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_result jsonb;
  v_db_size bigint;
  v_tables jsonb;
  v_tenant_storage jsonb;
BEGIN
  -- 1. Total Database Size in bytes
  SELECT pg_database_size(current_database()) INTO v_db_size;

  -- 2. Top Database Tables by Size (Live Catalog)
  SELECT jsonb_agg(t) INTO v_tables
  FROM (
    SELECT
      sio.relname AS table_name,
      pg_total_relation_size(sio.relid) AS total_bytes,
      pg_relation_size(sio.relid) AS table_bytes,
      pg_indexes_size(sio.relid) AS index_bytes,
      COALESCE(st.n_live_tup, 0) AS live_rows,
      COALESCE(st.n_dead_tup, 0) AS dead_rows,
      st.last_vacuum,
      st.last_autovacuum
    FROM pg_catalog.pg_statio_user_tables sio
    JOIN pg_stat_user_tables st ON st.relid = sio.relid
    ORDER BY pg_total_relation_size(sio.relid) DESC
    LIMIT 40
  ) t;

  -- 3. Tenant Database Footprint (Products count, orders count, plan limits, and store metadata)
  SELECT jsonb_agg(s) INTO v_tenant_storage
  FROM (
    SELECT
      st.id AS store_id,
      st.name AS store_name,
      st.subdomain,
      st.custom_domain,
      st.status,
      st.is_active,
      ss.logo_url,
      p.code AS plan_code,
      p.display_name AS plan_name,
      COALESCE((SELECT COUNT(*) FROM public.products pr WHERE pr.store_id = st.id), 0) AS products_count,
      COALESCE((SELECT COUNT(*) FROM public.orders ord WHERE ord.store_id = st.id), 0) AS orders_count
    FROM public.stores st
    LEFT JOIN public.site_settings ss ON ss.store_id = st.id
    LEFT JOIN public.store_subscriptions sub ON sub.store_id = st.id AND sub.status = 'active'
    LEFT JOIN public.plans p ON p.id = sub.plan_id
    ORDER BY products_count DESC, orders_count DESC
    LIMIT 100
  ) s;

  v_result := jsonb_build_object(
    'database_bytes', v_db_size,
    'tables', COALESCE(v_tables, '[]'::jsonb),
    'tenants', COALESCE(v_tenant_storage, '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;

-- Secure access: Revoke from public, permit only service_role
REVOKE ALL ON FUNCTION public.get_platform_storage_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_storage_metrics() TO service_role;
