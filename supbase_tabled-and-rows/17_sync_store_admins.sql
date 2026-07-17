-- Create a trigger function to automatically sync user_roles to store_admins
-- This ensures anyone assigned a role in a store is automatically added to store_admins,
-- satisfying the frontend login check and database RLS policies.

CREATE OR REPLACE FUNCTION public.sync_store_admins()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.store_id IS NOT NULL THEN
      INSERT INTO public.store_admins (user_id, store_id)
      VALUES (NEW.user_id, NEW.store_id)
      ON CONFLICT (user_id, store_id) DO NOTHING;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.store_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = OLD.user_id AND store_id = OLD.store_id
      ) THEN
        DELETE FROM public.store_admins 
        WHERE user_id = OLD.user_id AND store_id = OLD.store_id;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trg_sync_store_admins ON public.user_roles;

-- Create the trigger
CREATE TRIGGER trg_sync_store_admins
AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.sync_store_admins();

-- Populate store_admins for all existing roles
INSERT INTO public.store_admins (user_id, store_id)
SELECT DISTINCT user_id, store_id 
FROM public.user_roles 
WHERE store_id IS NOT NULL
ON CONFLICT (user_id, store_id) DO NOTHING;
