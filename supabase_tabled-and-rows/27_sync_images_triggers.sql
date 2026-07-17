-- 1. Update sync_store_image_usage to sum main images, gallery images, banners, logo, and favicon
CREATE OR REPLACE FUNCTION public.sync_store_image_usage(p_store_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_products_main_count bigint;
  v_products_gallery_count bigint;
  v_banners_count bigint;
  v_settings_count bigint;
  v_total bigint;
BEGIN
  -- Count product main images
  SELECT count(*) INTO v_products_main_count
  FROM public.products
  WHERE store_id = p_store_id AND is_active = true AND is_deleted = false AND image IS NOT NULL AND image <> '';
  
  -- Count product gallery images (number of elements in the gallery array)
  SELECT COALESCE(sum(COALESCE(cardinality(gallery), 0)), 0) INTO v_products_gallery_count
  FROM public.products
  WHERE store_id = p_store_id AND is_active = true AND is_deleted = false;
  
  -- Count banners
  SELECT count(*) INTO v_banners_count
  FROM public.banners
  WHERE store_id = p_store_id AND is_active = true;

  -- Count logo/favicon in settings
  SELECT (CASE WHEN logo_url IS NOT NULL AND logo_url <> '' THEN 1 ELSE 0 END) +
         (CASE WHEN favicon_url IS NOT NULL AND favicon_url <> '' THEN 1 ELSE 0 END) INTO v_settings_count
  FROM public.site_settings
  WHERE store_id = p_store_id;

  v_total := COALESCE(v_products_main_count, 0) + COALESCE(v_products_gallery_count, 0) + COALESCE(v_banners_count, 0) + COALESCE(v_settings_count, 0);

  -- Upsert into feature_usage
  INSERT INTO public.feature_usage (store_id, feature_key, period, period_start, period_end, usage_count)
  VALUES (p_store_id, 'uploaded_images', 'lifetime', to_timestamp(0), '9999-12-31 23:59:59+00'::timestamptz, v_total)
  ON CONFLICT (store_id, feature_key, period, period_start)
  DO UPDATE SET usage_count = v_total, updated_at = now();

  RETURN v_total;
END;
$$;

-- 2. Create trigger function for products table image sync
CREATE OR REPLACE FUNCTION public.trg_sync_product_image_usage()
RETURNS TRIGGER AS $$
DECLARE
  v_store_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_store_id := OLD.store_id;
  ELSE
    v_store_id := NEW.store_id;
  END IF;
  
  IF v_store_id IS NOT NULL THEN
    PERFORM public.sync_store_image_usage(v_store_id);
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to products table
DROP TRIGGER IF EXISTS trg_products_image_sync ON public.products;
CREATE TRIGGER trg_products_image_sync
AFTER INSERT OR UPDATE OR DELETE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_product_image_usage();

-- 3. Create trigger function for banners table image sync
CREATE OR REPLACE FUNCTION public.trg_sync_banner_image_usage()
RETURNS TRIGGER AS $$
DECLARE
  v_store_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_store_id := OLD.store_id;
  ELSE
    v_store_id := NEW.store_id;
  END IF;
  
  IF v_store_id IS NOT NULL THEN
    PERFORM public.sync_store_image_usage(v_store_id);
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to banners table
DROP TRIGGER IF EXISTS trg_banners_image_sync ON public.banners;
CREATE TRIGGER trg_banners_image_sync
AFTER INSERT OR UPDATE OR DELETE ON public.banners
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_banner_image_usage();

-- 4. Create trigger function for site_settings table image sync
CREATE OR REPLACE FUNCTION public.trg_sync_settings_image_usage()
RETURNS TRIGGER AS $$
DECLARE
  v_store_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_store_id := OLD.store_id;
  ELSE
    v_store_id := NEW.store_id;
  END IF;
  
  IF v_store_id IS NOT NULL THEN
    PERFORM public.sync_store_image_usage(v_store_id);
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to site_settings table
DROP TRIGGER IF EXISTS trg_settings_image_sync ON public.site_settings;
CREATE TRIGGER trg_settings_image_sync
AFTER INSERT OR UPDATE OR DELETE ON public.site_settings
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_settings_image_usage();

-- 5. Trigger synchronization once for all existing stores to update counts immediately
DO $$
DECLARE
  v_store_id uuid;
BEGIN
  FOR v_store_id IN SELECT id FROM public.stores LOOP
    PERFORM public.sync_store_image_usage(v_store_id);
  END LOOP;
END $$;
