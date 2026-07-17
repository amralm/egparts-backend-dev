-- Enable Super Admins (Platform Owners) to view and manage all user profiles
-- This fixes the "فشل جلب المدراء" (Failed to fetch managers/admins) error on the platform admin dashboard.

DROP POLICY IF EXISTS user_profiles_super_admin_all ON public.user_profiles;

CREATE POLICY user_profiles_super_admin_all ON public.user_profiles
    FOR ALL
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());
