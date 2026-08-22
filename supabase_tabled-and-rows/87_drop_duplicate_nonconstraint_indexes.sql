-- 87: Drop exact-duplicate non-constraint indexes.
--
-- Kept intentionally OUT of scope: the seven unique-index pairs where BOTH
-- sides back live constraints (feature_limits, notification_templates,
-- plan_features, product_stock, roles, store_admins,
-- store_payment_gateways). Dropping a constraint side changes ON CONFLICT /
-- upsert semantics; those stay until a dedicated naming-consolidation pass
-- verifies no RPC references the dropped constraint by name.
--
-- Removed here: plain btree twins with identical columns and no constraint
-- backing (pure write amplification):
--   - order_items(order_id): keep idx_order_items_order_id
--   - products(store_id,is_active,is_deleted): keep idx_products_store_active_deleted

DROP INDEX IF EXISTS public.idx_order_items_order;
DROP INDEX IF EXISTS public.idx_products_store_active;
