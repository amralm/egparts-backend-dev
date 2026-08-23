-- Vehicle metadata is consumed through the backend service-role tool layer;
-- browsers must not query these tables directly. Explicit deny policies make
-- the RLS posture unambiguous instead of relying on an empty policy set.
DO $$
BEGIN
  IF to_regclass('public.vehicle_brands') IS NOT NULL THEN
    ALTER TABLE public.vehicle_brands ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS vehicle_brands_deny_browser ON public.vehicle_brands;
    CREATE POLICY vehicle_brands_deny_browser ON public.vehicle_brands
      FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
  IF to_regclass('public.vehicle_models') IS NOT NULL THEN
    ALTER TABLE public.vehicle_models ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS vehicle_models_deny_browser ON public.vehicle_models;
    CREATE POLICY vehicle_models_deny_browser ON public.vehicle_models
      FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
