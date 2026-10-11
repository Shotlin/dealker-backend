-- 203_repair_vendor_profile.sql
-- Vendor-app support for the repair marketplace: per-shop "accepting repair requests" switch and device colour.
CREATE TABLE IF NOT EXISTS repair_vendor_profiles (
  vendor_id UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  accepting_requests BOOLEAN NOT NULL DEFAULT TRUE,   -- "Service available in nearby areas"
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE repair_items ADD COLUMN IF NOT EXISTS color VARCHAR(40);
