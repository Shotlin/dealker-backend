-- 179_pricing_and_merchandising.sql
-- Global price control (percent / fixed / set / discount-from-MRP, with
-- preview and one-click revert), bulk stock updates, and product sections
-- (New Arrival, Deal of the Day, Clearance, Featured, Best Seller) with
-- B2C / B2B sales-channel flags. Additive and idempotent.

-- ── 1. Merchandising on the listing ───────────────────────────────────────
ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS merch_section TEXT
    CHECK (merch_section IS NULL OR merch_section IN
      ('NEW_ARRIVAL', 'DEAL_OF_THE_DAY', 'CLEARANCE_SALE', 'FEATURED', 'BEST_SELLER')),
  ADD COLUMN IF NOT EXISTS merch_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merch_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merch_position INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS merch_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sell_b2c BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sell_b2b BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_shop_products_section
  ON shop_products (merch_section, merch_position) WHERE merch_section IS NOT NULL AND deleted_at IS NULL;

-- ── 2. Bulk price / stock batches (audit + revert) ────────────────────────
CREATE TABLE IF NOT EXISTS price_adjustment_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('PRICE', 'STOCK')),
  operation TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'REVERTED')),
  item_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reverted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reverted_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_price_batches_created ON price_adjustment_batches(created_at DESC);

CREATE TABLE IF NOT EXISTS price_adjustment_items (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES price_adjustment_batches(id) ON DELETE CASCADE,
  shop_product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('sale_price', 'wholesale_price', 'stock_quantity')),
  old_value NUMERIC(12,2),
  new_value NUMERIC(12,2) NOT NULL,
  UNIQUE (batch_id, shop_product_id, field)
);
CREATE INDEX IF NOT EXISTS idx_price_items_listing ON price_adjustment_items(shop_product_id);

-- ── 3. Permissions ────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['pricing.view','pricing.manage','merchandising.view','merchandising.manage'])))
   )
 WHERE name IN ('Platform Admin', 'Catalog Manager');
