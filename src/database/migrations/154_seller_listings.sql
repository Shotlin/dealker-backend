-- 154_seller_listings.sql
-- Extends shop_products into the marketplace Seller Listing: the per-vendor
-- offer of a master-catalog product, with seller-specific pricing, inventory,
-- fulfilment and shipping attributes. The master product record is never
-- duplicated per vendor.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS seller_sku VARCHAR(64),
  ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2) CHECK (mrp IS NULL OR mrp >= 0),
  ADD COLUMN IF NOT EXISTS min_order_qty SMALLINT NOT NULL DEFAULT 1 CHECK (min_order_qty >= 1),
  ADD COLUMN IF NOT EXISTS handling_time_days SMALLINT NOT NULL DEFAULT 2
    CHECK (handling_time_days BETWEEN 0 AND 30),
  ADD COLUMN IF NOT EXISTS weight_grams INTEGER CHECK (weight_grams IS NULL OR weight_grams > 0),
  ADD COLUMN IF NOT EXISTS package_length_cm DECIMAL(6,2) CHECK (package_length_cm IS NULL OR package_length_cm > 0),
  ADD COLUMN IF NOT EXISTS package_width_cm DECIMAL(6,2) CHECK (package_width_cm IS NULL OR package_width_cm > 0),
  ADD COLUMN IF NOT EXISTS package_height_cm DECIMAL(6,2) CHECK (package_height_cm IS NULL OR package_height_cm > 0),
  ADD COLUMN IF NOT EXISTS cod_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS nationwide_shipping_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS local_delivery_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS listing_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (listing_status IN ('ACTIVE', 'PAUSED', 'OUT_OF_STOCK'));

-- A seller SKU is unique within a vendor's shop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_products_seller_sku
  ON shop_products(shop_id, seller_sku)
  WHERE seller_sku IS NOT NULL AND deleted_at IS NULL;

-- Master catalogue tax classification (marketplace GST invoicing).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2) CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100)),
  ADD COLUMN IF NOT EXISTS brand VARCHAR(120),
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS return_policy_days SMALLINT NOT NULL DEFAULT 7;

CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand) WHERE brand IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE shop_products IS 'Marketplace seller listing: one vendor/shop offer of a master product (154).';
