-- ============================================================
-- Stock Safety: Add CHECK constraint to prevent negative stock
-- ============================================================
-- This is a belt-and-suspenders safety net alongside the
-- FOR UPDATE row-level locking added to create_order_atomic.
-- If a race condition somehow bypasses the lock, this constraint
-- will cause the UPDATE to fail, rolling back the entire transaction.
--
-- Run this ONCE in the Supabase SQL Editor.

ALTER TABLE public.products
ADD CONSTRAINT products_stock_non_negative
CHECK (stock_quantity >= 0);
