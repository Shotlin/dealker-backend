-- 048_product_families_and_options.sql
-- Product families / option groups for multi-option grocery products.
--
-- Model: Each purchasable option (e.g. Tomato 500g, Tomato 1kg) remains a
-- distinct `products` row. A `product_families` table groups related options
-- under a shared family name. Products without a product_family_id behave as
-- single-option products (backward-compatible).
--
-- Cart/order identity is unchanged: (product_id, shop_id) still uniquely
-- identifies a purchasable line item. No changes to shop_products, cart, or
-- orders tables.
--
-- The existing `product_variants` table is NOT modified — it remains a
-- legacy/display-only structure until a future migration deprecates it.
--
-- Idempotent: all statements use IF NOT EXISTS patterns.
-- Requirements: Product option/variant system for grocery platform.

-- ═══════════════════════════════════════════════════════════════
-- 1. PRODUCT_FAMILIES TABLE
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_families (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(300) UNIQUE NOT NULL,
  category_id     UUID NULL REFERENCES categories(id) ON DELETE SET NULL,
  thumbnail_url   TEXT NULL,
  description     TEXT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_families_category_id
  ON product_families (category_id);

CREATE INDEX IF NOT EXISTS idx_product_families_is_active
  ON product_families (is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_product_families_slug
  ON product_families (slug);

-- ═══════════════════════════════════════════════════════════════
-- 2. EXTEND PRODUCTS TABLE WITH OPTION/FAMILY FIELDS
-- ═══════════════════════════════════════════════════════════════

-- Family grouping (NULL = standalone product, no options popup)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_family_id UUID NULL
    REFERENCES product_families(id) ON DELETE SET NULL;

-- Option display fields
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS option_label VARCHAR(100) NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS option_sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_default_option BOOLEAN NOT NULL DEFAULT false;

-- Food type marker (VEG/NON_VEG/EGG/NONE)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS food_type VARCHAR(20) NOT NULL DEFAULT 'NONE';

-- Origin tag (IMPORTED/LOCAL/NONE)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS origin_tag VARCHAR(20) NOT NULL DEFAULT 'NONE';

-- Custom badges (e.g. ["Bestseller", "New", "Organic"])
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS custom_badges JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Delivery time display (minutes, shown on product card)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS display_delivery_minutes INTEGER NULL;

-- ═══════════════════════════════════════════════════════════════
-- 3. CHECK CONSTRAINTS
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_food_type'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_food_type
      CHECK (food_type IN ('VEG', 'NON_VEG', 'EGG', 'NONE'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_origin_tag'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_origin_tag
      CHECK (origin_tag IN ('IMPORTED', 'LOCAL', 'NONE'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_delivery_minutes'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_delivery_minutes
      CHECK (display_delivery_minutes IS NULL OR (display_delivery_minutes BETWEEN 1 AND 180));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 4. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Find all options in a family (for option popup)
CREATE INDEX IF NOT EXISTS idx_products_product_family_id
  ON products (product_family_id)
  WHERE product_family_id IS NOT NULL;

-- Sort options within a family
CREATE INDEX IF NOT EXISTS idx_products_family_sort
  ON products (product_family_id, option_sort_order)
  WHERE product_family_id IS NOT NULL;

-- Food type filter
CREATE INDEX IF NOT EXISTS idx_products_food_type
  ON products (food_type)
  WHERE food_type != 'NONE';

-- Origin tag filter
CREATE INDEX IF NOT EXISTS idx_products_origin_tag
  ON products (origin_tag)
  WHERE origin_tag != 'NONE';
