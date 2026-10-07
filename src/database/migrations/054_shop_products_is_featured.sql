-- 054_shop_products_is_featured.sql
-- Add is_featured column to shop_products so per-shop featured status
-- can be set independently of the master-catalog is_featured flag.
-- Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE defaulting existing rows to false.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN shop_products.is_featured IS
  'Per-shop featured flag, independent of products.is_featured.';
