-- 1. Drop global unique constraints on phone column to allow multi-tenant compatibility
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_key;
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_key1;
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_phone_key2;
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_store_id_phone_key;

-- 2. Create trigger function to ensure a phone number cannot be linked to different user accounts (user_id)
-- but allows the same user account (user_id) to use their phone number across multiple stores/tenants.
CREATE OR REPLACE FUNCTION public.check_unique_phone_per_user()
RETURNS trigger AS $$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE phone = NEW.phone
        AND user_id <> NEW.user_id
    ) THEN
      RAISE EXCEPTION 'رقم الهاتف هذا مرتبط بحساب آخر بالفعل.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Deploy the trigger to run before insert or update
DROP TRIGGER IF EXISTS trg_check_unique_phone_per_user ON public.user_profiles;
CREATE TRIGGER trg_check_unique_phone_per_user
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_unique_phone_per_user();
