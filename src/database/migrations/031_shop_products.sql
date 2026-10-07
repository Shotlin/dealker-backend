-- 031_shop_products.sql
-- Create shop_products table for per-shop inventory and pricing
-- Supports stock tracking, pricing overrides, low-stock alerts, sold-out detection

-- ═══════════════════════════════════════════════════════════════
-- 1. SHOP_PRODUCTS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_products (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  shop_id               UUID NOT NULL REFERENCES shops(id),
  product_id            UUID NOT NULL REFERENCES products(id),

  -- Pricing (NULL price means inherit from products table)
  price                 DECIMAL(10,2)
                        CONSTRAINT chk_shop_products_price CHECK (price IS NULL OR (price >= 0.01 AND price <= 99999999.99)),
  sale_price            DECIMAL(10,2)
                        CONSTRAINT chk_shop_products_sale_price CHECK (sale_price IS NULL OR (sale_price >= 0.01 AND sale_price <= 99999999.99)),
  cost_price            DECIMAL(10,2)
                        CONSTRAINT chk_shop_products_cost_price CHECK (cost_price IS NULL OR (cost_price >= 0.00 AND cost_price <= 99999999.99)),

  -- Inventory
  stock_quantity        INTEGER NOT NULL DEFAULT 0
                        CONSTRAINT chk_shop_products_stock_quantity CHECK (stock_quantity >= 0),
  low_stock_threshold   INTEGER NOT NULL DEFAULT 5
                        CONSTRAINT chk_shop_products_low_stock_threshold CHECK (low_stock_threshold >= 0),
  max_order_qty         INTEGER NOT NULL DEFAULT 50
                        CONSTRAINT chk_shop_products_max_order_qty CHECK (max_order_qty >= 1 AND max_order_qty <= 10000),

  -- Availability
  is_available          BOOLEAN DEFAULT true,
  sold_out_at           TIMESTAMPTZ NULL,

  -- Soft Delete
  deleted_at            TIMESTAMPTZ NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT uq_shop_products_shop_product UNIQUE (shop_id, product_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Partial index for active listings (excludes soft-deleted)
CREATE INDEX IF NOT EXISTS idx_shop_products_shop_available
  ON shop_products (shop_id, is_available)
  WHERE deleted_at IS NULL;

-- Product lookup (find all shops carrying a product)
CREATE INDEX IF NOT EXISTS idx_shop_products_product_id
  ON shop_products (product_id);

-- Low stock alerts (partial index using literal threshold for IMMUTABLE compliance)
CREATE INDEX IF NOT EXISTS idx_shop_products_low_stock
  ON shop_products (shop_id)
  WHERE stock_quantity <= 5;
