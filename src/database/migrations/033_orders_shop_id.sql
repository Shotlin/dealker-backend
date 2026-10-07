-- 033_orders_shop_id.sql
-- Multi-vendor: associate each order with a Shop.
--
-- Adds shop_id FK on orders so that the Order_Splitter (req 5.6) can produce
-- one order per Shop at checkout, and so that downstream queries (vendor
-- dashboards, settlement worker, payout history) can scope orders by Shop.
--
-- Idempotent (req 15.8): ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
--
-- Nullability:
--   shop_id is intentionally NULLABLE for now. Existing pre-multi-vendor
--   orders have no associated shop and would otherwise break the migration.
--   The OrderSplitter introduced in task 6.2 populates shop_id on every new
--   order. A follow-up migration may backfill historical rows and tighten
--   the column to NOT NULL once all legacy orders have been resolved.
--
-- Index:
--   The composite (shop_id, status, created_at DESC) supports the dominant
--   vendor-dashboard access pattern: "list a shop's orders, filtered by
--   status, newest first". A partial predicate (shop_id IS NOT NULL) keeps
--   the index small during the transition period while many rows still
--   carry NULL shop_id.

-- ═══════════════════════════════════════════════════════════════
-- 1. ADD shop_id COLUMN TO orders
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEX FOR SHOP-SCOPED ORDER LISTINGS
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_orders_shop_id_status_created
  ON orders (shop_id, status, created_at DESC)
  WHERE shop_id IS NOT NULL;
