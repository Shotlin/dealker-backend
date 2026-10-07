-- Migration 016: Add missing product detail columns
-- These fields are needed by the admin product edit form

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS barcode             VARCHAR(100),
  ADD COLUMN IF NOT EXISTS max_order_qty       INTEGER,
  ADD COLUMN IF NOT EXISTS ingredients         TEXT,
  ADD COLUMN IF NOT EXISTS allergen_info       TEXT,
  ADD COLUMN IF NOT EXISTS shelf_life          VARCHAR(200),
  ADD COLUMN IF NOT EXISTS storage_instructions TEXT,
  ADD COLUMN IF NOT EXISTS certifications      TEXT[],
  ADD COLUMN IF NOT EXISTS nutrition_info      JSONB,
  ADD COLUMN IF NOT EXISTS meta_title          VARCHAR(160),
  ADD COLUMN IF NOT EXISTS meta_description    TEXT;

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
