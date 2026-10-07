-- 153_marketplace_vendor_shops.sql
-- Marketplace foundation: a shop becomes a vendor-owned fulfilment location.
-- A vendor may operate one or more shops; marketplace visibility, commission
-- and settlement flow through the vendor -> shop relationship.

-- Link shops to the vendor that owns/operates them (nullable for legacy
-- platform-operated stores until data backfill, if any).
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pickup_capable BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS warehouse_status TEXT NOT NULL DEFAULT 'OPERATIONAL'
    CHECK (warehouse_status IN ('OPERATIONAL', 'TEMPORARILY_CLOSED', 'PERMANENTLY_CLOSED')),
  ADD COLUMN IF NOT EXISTS seller_rating NUMERIC(3,2) NOT NULL DEFAULT 0
    CHECK (seller_rating >= 0 AND seller_rating <= 5),
  ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_shops_vendor ON shops(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shops_vendor_active ON shops(vendor_id, is_active) WHERE deleted_at IS NULL;

-- Convenience: vendor display name for a shop (marketplace listing surfaces)
COMMENT ON COLUMN shops.vendor_id IS 'Vendor that operates this fulfilment location. NULL = platform-operated (legacy).';
