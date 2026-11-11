-- Per-unit QC for used / refurbished / open-box listings: a listing with N units has N QC reports (Device 1 … Device N).
-- Units are sold in order: the first (units - stock_quantity) are sold, the rest are available, so no order hook is needed.
CREATE TABLE IF NOT EXISTS listing_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  unit_no INTEGER NOT NULL CHECK (unit_no >= 1),
  imei TEXT,
  qc JSONB NOT NULL,
  qc_score INTEGER NOT NULL,
  battery_health INTEGER,
  defects INTEGER NOT NULL DEFAULT 0,
  checked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_product_id, unit_no)
);
CREATE INDEX IF NOT EXISTS idx_listing_units_listing ON listing_units (shop_product_id, unit_no);
