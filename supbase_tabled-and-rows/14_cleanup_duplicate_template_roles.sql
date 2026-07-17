-- Clean up duplicate tenant template roles in the roles table.
-- PostgreSQL UNIQUE constraints allow duplicate NULLs (so multiple rows with store_id = null and the same role name can exist).
-- This script keeps only one role (the one with the oldest ID/creation) for each role name under the tenant_template type.

DELETE FROM public.roles a
USING public.roles b
WHERE a.id > b.id
  AND a.name = b.name
  AND a.role_type = b.role_type
  AND a.store_id IS NULL
  AND b.store_id IS NULL
  AND a.role_type = 'tenant_template';
