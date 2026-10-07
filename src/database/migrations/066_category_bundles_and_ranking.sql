-- 066_category_bundles_and_ranking.sql
--
-- Adds two related features:
--
-- 1. Product bundles: a category with category_type = 'BUNDLE' is a
--    promo-only grouping of products (e.g. "Milkshake offer" = Mango + Milk
--    + Sugar), excluded from the public category list/menu but still
--    fetchable by id — so a banner can deep-link to it via the existing
--    link_type='category' mechanism with zero banner-schema changes.
--    Bundle membership never touches products.category_id, so a product
--    keeps showing in its real category while also appearing in the bundle.
--
-- 2. Category product ranking: category_products.rank lets an admin pin an
--    explicit display order for products within a STANDARD category too
--    (optional — unranked products fall back to a deterministic
--    created_at DESC, id ASC order instead of the previous nondeterministic
--    tie-break that caused inconsistent ordering).
--
-- Fully additive: safe default on the new column, brand-new join table, no
-- backfill, no impact on existing categories/products/orders.

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS category_type VARCHAR(20) NOT NULL DEFAULT 'STANDARD'
    CONSTRAINT chk_categories_type CHECK (category_type IN ('STANDARD', 'BUNDLE'));

CREATE TABLE IF NOT EXISTS category_products (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rank        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_category_products_rank ON category_products (category_id, rank);
CREATE INDEX IF NOT EXISTS idx_category_products_product ON category_products (product_id);
