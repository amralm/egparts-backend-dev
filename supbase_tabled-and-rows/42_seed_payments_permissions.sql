-- ============================================================
-- Migration 42: Seed Payments Permissions
-- Fixes "Missing permission 'payments.approve'" error
-- ============================================================

BEGIN;

-- 1. Insert permissions into public.permissions
INSERT INTO public.permissions (id, name, description, module)
VALUES 
  (gen_random_uuid(), 'payments.view', 'عرض إعدادات الدفع وإيصالات المحافظ المعلقة', 'payments'),
  (gen_random_uuid(), 'payments.configure', 'إعداد بوابات الدفع والمحافظ الإلكترونية', 'payments'),
  (gen_random_uuid(), 'payments.approve', 'مراجعة وتأكيد أو رفض دفعات المحافظ الإلكترونية', 'payments')
ON CONFLICT (name) DO NOTHING;

-- 2. Add to platform_role_templates (for new stores)
UPDATE public.platform_role_templates
SET permissions = (
  SELECT jsonb_agg(DISTINCT elem)
  FROM jsonb_array_elements(
    COALESCE(permissions, '[]'::jsonb) || 
    '["payments.view", "payments.configure", "payments.approve"]'::jsonb
  ) AS elem
)
WHERE name IN ('owner', 'admin');

-- 3. Add to existing roles (for existing stores)
DO $$
DECLARE
  v_role RECORD;
  v_perm_id uuid;
  v_perm_name text;
  v_perms text[] := ARRAY['payments.view', 'payments.configure', 'payments.approve'];
BEGIN
  FOR v_role IN 
    SELECT id FROM public.roles WHERE name IN ('owner', 'admin')
  LOOP
    FOREACH v_perm_name IN ARRAY v_perms
    LOOP
      SELECT id INTO v_perm_id FROM public.permissions WHERE name = v_perm_name;
      IF v_perm_id IS NOT NULL THEN
        INSERT INTO public.role_permissions (role_id, permission_id)
        VALUES (v_role.id, v_perm_id)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
