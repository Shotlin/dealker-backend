-- 229_vendor_perf_indexes.sql
-- Vendor app speed: the Orders list and the home "New orders" block read seller_orders per vendor, newest first
-- (WHERE vendor_id = $1 [AND status = $2] ORDER BY created_at DESC LIMIT n). The old single-column vendor_id index
-- forced a sort of ALL of that vendor's orders on every call; these let Postgres read the first rows in order.
-- Additive and idempotent (IF NOT EXISTS). Tables are small enough that a plain CREATE INDEX is instant.

CREATE INDEX IF NOT EXISTS idx_seller_orders_vendor_created
  ON seller_orders (vendor_id, created_at DESC) WHERE vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_orders_vendor_status_created
  ON seller_orders (vendor_id, status, created_at DESC) WHERE vendor_id IS NOT NULL;
