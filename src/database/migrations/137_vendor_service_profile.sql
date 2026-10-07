-- Migration 137: Vendor Supply Categories, Service Areas & Store Assignments
-- Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §4.1, §5.2
-- Procurement targeting inputs consumed by vendor-eligibility.js. Narrow join
-- tables (not JSONB) so candidate queries can filter/join efficiently.

-- 1. Categories a vendor supplies (Chicken, Mutton, Fish/Seafood, Eggs, ...)
CREATE TABLE IF NOT EXISTS vendor_supply_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vendor_supply_category UNIQUE (vendor_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_supply_categories_vendor ON vendor_supply_categories(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_supply_categories_category ON vendor_supply_categories(category_id);

-- 2. Service areas as 6-digit pincodes (normalized)
CREATE TABLE IF NOT EXISTS vendor_service_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vendor_service_area UNIQUE (vendor_id, pincode)
);

CREATE INDEX IF NOT EXISTS idx_vendor_service_areas_vendor ON vendor_service_areas(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_service_areas_pincode ON vendor_service_areas(pincode);

-- 3. Explicit store assignments (store-first targeting override)
CREATE TABLE IF NOT EXISTS vendor_store_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vendor_store_assignment UNIQUE (vendor_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_store_assignments_vendor ON vendor_store_assignments(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_store_assignments_shop ON vendor_store_assignments(shop_id);
