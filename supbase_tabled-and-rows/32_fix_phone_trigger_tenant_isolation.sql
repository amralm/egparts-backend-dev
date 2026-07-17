-- 1. Update the trigger function to ensure phone uniqueness per store (Tenant Isolation)
CREATE OR REPLACE FUNCTION public.check_unique_phone_per_user()
RETURNS trigger AS $$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE phone = NEW.phone
        AND store_id = NEW.store_id
        AND user_id <> NEW.user_id
    ) THEN
      RAISE EXCEPTION 'رقم الهاتف هذا مسجل بحساب آخر في هذا المتجر بالفعل.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Ensure trigger is properly linked (Re-apply just in case)
DROP TRIGGER IF EXISTS trg_check_unique_phone_per_user ON public.user_profiles;
CREATE TRIGGER trg_check_unique_phone_per_user
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_unique_phone_per_user();
