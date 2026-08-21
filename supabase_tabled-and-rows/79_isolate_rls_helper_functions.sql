-- Keep the public function signatures used by existing policies and backend
-- callers, but move privileged implementations out of the exposed `public`
-- schema. Public wrappers are invoker functions and therefore are not
-- SECURITY DEFINER RPC endpoints.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

ALTER FUNCTION public.get_my_stores() SET SCHEMA private;
ALTER FUNCTION public.is_platform_owner() SET SCHEMA private;
ALTER FUNCTION public.is_store_active(uuid) SET SCHEMA private;
ALTER FUNCTION public.is_super_admin() SET SCHEMA private;
ALTER FUNCTION public.row_store_id_from_branch(uuid) SET SCHEMA private;
ALTER FUNCTION public.row_store_id_from_product(uuid) SET SCHEMA private;
ALTER FUNCTION public.row_store_id_from_shelf(uuid) SET SCHEMA private;
ALTER FUNCTION public.row_store_id_from_warehouse(uuid) SET SCHEMA private;

REVOKE ALL ON FUNCTION private.get_my_stores() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_platform_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_store_active(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.row_store_id_from_branch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.row_store_id_from_product(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.row_store_id_from_shelf(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.row_store_id_from_warehouse(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_my_stores() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_platform_owner() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_store_active(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_super_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.row_store_id_from_branch(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.row_store_id_from_product(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.row_store_id_from_shelf(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.row_store_id_from_warehouse(uuid) TO authenticated, service_role;
-- Public storefront policies call this helper for anon visitors.
GRANT EXECUTE ON FUNCTION private.is_store_active(uuid) TO anon;

CREATE OR REPLACE FUNCTION public.get_my_stores()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT * FROM private.get_my_stores(); $$;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.is_platform_owner(); $$;

CREATE OR REPLACE FUNCTION public.is_store_active(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.is_store_active(p_store_id); $$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.is_super_admin(); $$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_branch(p_branch_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.row_store_id_from_branch(p_branch_id); $$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_product(p_product_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.row_store_id_from_product(p_product_id); $$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_shelf(p_shelf_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.row_store_id_from_shelf(p_shelf_id); $$;

CREATE OR REPLACE FUNCTION public.row_store_id_from_warehouse(p_warehouse_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public
AS $$ SELECT private.row_store_id_from_warehouse(p_warehouse_id); $$;

REVOKE EXECUTE ON FUNCTION public.get_my_stores() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_platform_owner() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_store_active(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.row_store_id_from_branch(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.row_store_id_from_product(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.row_store_id_from_shelf(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.row_store_id_from_warehouse(uuid) FROM anon;
