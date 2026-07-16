-- ============================================================
-- Fix Hard Delete Constraint for Products
-- ============================================================
-- هذا السكربت يقوم بتعديل العلاقات (Foreign Keys) لجداول الطلبات والمخزون
-- بحيث إذا قمت بحذف منتج نهائياً، لا يتم حذف الطلبات السابقة ولا ينهار النظام،
-- بل يتم وضع `product_id = NULL` في تلك الطلبات مع الاحتفاظ بالسعر واسم المنتج في الفاتورة.

DO $$
BEGIN
  -- 1. Fix order_items foreign key
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'order_items_product_id_fkey') THEN
    ALTER TABLE public.order_items DROP CONSTRAINT order_items_product_id_fkey;
  END IF;
  
  ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_product_id_fkey 
    FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;

  -- 2. Fix inventory_adjustments foreign key
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'inventory_adjustments_product_id_fkey') THEN
    ALTER TABLE public.inventory_adjustments DROP CONSTRAINT inventory_adjustments_product_id_fkey;
  END IF;

  ALTER TABLE public.inventory_adjustments
    ADD CONSTRAINT inventory_adjustments_product_id_fkey 
    FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

END $$;
