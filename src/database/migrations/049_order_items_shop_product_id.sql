-- 049_order_items_shop_product_id.sql
-- Phase 3: track exact shop_product (per-shop SKU) and shop_id on each
-- order item so multi-vendor orders can be audited back to the precise
-- shop_products row that fulfilled the line.
--
-- Both columns are NULLABLE so:
--   - existing order_items rows remain valid (no backfill needed)
--   - legacy callers that don't pass shop_product_id still succeed
--   - rolling deploys work safely
--
-- New orders created via OrderSplitter (Phase 3 onward) populate both
-- columns. Old orders keep shop_product_id NULL — auditors can still
-- reach the shop via the orders.shop_id column added in migration 033.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Requirements: Phase 3 cart/order exact option identity hardening.

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS shop_product_id UUID NULL
    REFERENCES shop_products(id);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS shop_id UUID NULL
    REFERENCES shops(id);

-- Reverse lookup: "all order items that hit a given shop_product"
-- (used by inventory audit reports). Partial index excludes legacy
-- rows so the index stays compact during the rollout.
CREATE INDEX IF NOT EXISTS idx_order_items_shop_product_id
  ON order_items (shop_product_id)
  WHERE shop_product_id IS NOT NULL;

-- Per-shop order-item listing for shop dashboards.
CREATE INDEX IF NOT EXISTS idx_order_items_shop_id
  ON order_items (shop_id)
  WHERE shop_id IS NOT NULL;

COMMENT ON COLUMN order_items.shop_product_id IS
  'Phase 3: exact shop_products row that fulfilled this item. NULL on legacy orders.';

COMMENT ON COLUMN order_items.shop_id IS
  'Phase 3: shop that fulfilled this item. Mirrors orders.shop_id; NULL on legacy orders.';
