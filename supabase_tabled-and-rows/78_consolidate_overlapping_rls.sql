-- Consolidate exact/subsumed policies without changing the intended tenant
-- boundaries. The public/anon policies remain separate where required.

-- Duplicate service-role policy.
DROP POLICY IF EXISTS service_role_all_client_error_logs ON public.client_error_logs;

-- Duplicate super-admin policy; the *_all policy already has USING and CHECK.
DROP POLICY IF EXISTS impersonation_logs_admin ON public.impersonation_logs;
DROP POLICY IF EXISTS impersonation_super_admin_all ON public.impersonation_logs;
CREATE POLICY impersonation_super_admin_all
  ON public.impersonation_logs FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- Inactive shipping zones must not be visible to storefront users.
DROP POLICY IF EXISTS zones_select_public ON public.shipping_zones;

-- The active public policy is the canonical store visibility rule.
DROP POLICY IF EXISTS stores_public_active_select ON public.stores;
DROP POLICY IF EXISTS stores_super_admin ON public.stores;

-- Exact duplicate super-admin policy.
DROP POLICY IF EXISTS super_admins_super_admin ON public.super_admins;

-- The self/admin SELECT policy subsumes the admin-only SELECT policy.
DROP POLICY IF EXISTS store_admins_select ON public.store_admins;
DROP POLICY IF EXISTS store_admins_super_admin ON public.store_admins;

-- The broader nullable/self policy subsumes the stricter insert policy.
DROP POLICY IF EXISTS login_logs_insert ON public.user_login_logs;

-- Merge tenant-admin, self, and super-admin profile access into one explicit
-- union. Keep the anonymous bootstrap insert policy and remove only policies
-- whose conditions are now represented by this union.
DROP POLICY IF EXISTS profiles_admin_all ON public.user_profiles;
DROP POLICY IF EXISTS profiles_self_all ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_super_admin_all ON public.user_profiles;
DROP POLICY IF EXISTS profiles_select_customer ON public.user_profiles;
DROP POLICY IF EXISTS profiles_update_customer ON public.user_profiles;
CREATE POLICY user_profiles_authenticated_all
  ON public.user_profiles FOR ALL TO authenticated
  USING (
    store_id IN (SELECT public.get_my_stores())
    OR user_id = (SELECT auth.uid())
    OR public.is_super_admin()
  )
  WITH CHECK (
    store_id IN (SELECT public.get_my_stores())
    OR user_id = (SELECT auth.uid())
    OR public.is_super_admin()
  );

-- Merge role-management policies while retaining the separate template-read
-- policy for tenant templates.
DROP POLICY IF EXISTS roles_super_admin_all ON public.roles;
DROP POLICY IF EXISTS roles_tenant_manage ON public.roles;
CREATE POLICY roles_authenticated_manage
  ON public.roles FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR (
      store_id IS NOT NULL
      AND role_type = 'tenant'
      AND store_id IN (SELECT public.get_my_stores())
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      store_id IS NOT NULL
      AND role_type = 'tenant'
      AND store_id IN (SELECT public.get_my_stores())
    )
  );

-- Merge the super-admin and tenant-management unions for user roles.
DROP POLICY IF EXISTS user_roles_super_admin_all ON public.user_roles;
DROP POLICY IF EXISTS user_roles_tenant_manage ON public.user_roles;
CREATE POLICY user_roles_authenticated_manage
  ON public.user_roles FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR (
      store_id IN (SELECT public.get_my_stores())
      AND EXISTS (
        SELECT 1 FROM public.roles r
        WHERE r.id = user_roles.role_id
          AND r.store_id = user_roles.store_id
          AND r.role_type = 'tenant'
      )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      store_id IN (SELECT public.get_my_stores())
      AND EXISTS (
        SELECT 1 FROM public.roles r
        WHERE r.id = user_roles.role_id
          AND r.store_id = user_roles.store_id
          AND r.role_type = 'tenant'
      )
    )
  );
