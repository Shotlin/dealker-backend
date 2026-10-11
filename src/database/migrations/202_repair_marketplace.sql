-- 202_repair_marketplace.sql
-- Repair quote marketplace: a customer posts a repair request, nearby repair vendors quote on it, the customer
-- compares the offers, picks one and chooses pickup & delivery or a shop appointment.
-- Extends 189_repairs (same lifecycle after the offer is selected). Additive and idempotent.

-- ── Marketplace settings ────────────────────────────────────────────────
ALTER TABLE repair_settings
  ADD COLUMN IF NOT EXISTS marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_quote_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS search_radius_km INTEGER NOT NULL DEFAULT 15 CHECK (search_radius_km BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS offer_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (offer_window_hours BETWEEN 1 AND 336),
  ADD COLUMN IF NOT EXISTS max_offers INTEGER NOT NULL DEFAULT 12 CHECK (max_offers BETWEEN 1 AND 50);

-- ── Issues: a device can have several problems; add the two the app offers that 189 did not have ─
ALTER TABLE repair_items DROP CONSTRAINT IF EXISTS repair_items_problem_category_check;
ALTER TABLE repair_items ADD CONSTRAINT repair_items_problem_category_check CHECK (problem_category IN (
  'SCREEN','BATTERY','CHARGING','WATER_DAMAGE','SOFTWARE','CAMERA','AUDIO','BODY','BOARD','BIOMETRIC','DATA','TOUCH','NETWORK','OTHER'));
ALTER TABLE repair_items ADD COLUMN IF NOT EXISTS problem_categories TEXT[] NOT NULL DEFAULT '{}';
UPDATE repair_items SET problem_categories = ARRAY[problem_category] WHERE cardinality(problem_categories) = 0;

-- ── Vendor price list: "what we repair, and for how much" ────────────────
CREATE TABLE IF NOT EXISTS repair_vendor_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  device_category TEXT NOT NULL DEFAULT 'Smartphone' CHECK (device_category IN ('Smartphone', 'Tablet', 'Laptop', 'Other')),
  brand VARCHAR(60) NOT NULL,
  model VARCHAR(120),                         -- NULL = every model of the brand
  problem_category TEXT NOT NULL CHECK (problem_category IN (
    'SCREEN','BATTERY','CHARGING','WATER_DAMAGE','SOFTWARE','CAMERA','AUDIO','BODY','BOARD','BIOMETRIC','DATA','TOUCH','NETWORK','OTHER')),
  title VARCHAR(120) NOT NULL,                -- "Display replacement"
  parts_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (parts_price >= 0),
  labour_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (labour_price >= 0),
  est_days_min INTEGER NOT NULL DEFAULT 1 CHECK (est_days_min BETWEEN 0 AND 60),
  est_days_max INTEGER NOT NULL DEFAULT 2 CHECK (est_days_max BETWEEN 0 AND 60),
  warranty_days INTEGER NOT NULL DEFAULT 90 CHECK (warranty_days BETWEEN 0 AND 730),
  pickup_delivery BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (est_days_max >= est_days_min),
  CHECK (parts_price + labour_price > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repair_vendor_service
  ON repair_vendor_services (vendor_id, device_category, lower(brand), COALESCE(lower(model), ''), problem_category);
CREATE INDEX IF NOT EXISTS idx_repair_vendor_services_match
  ON repair_vendor_services (lower(brand), problem_category) WHERE is_active;

-- ── Request: where the device is, how the customer wants it handled, rating ──
ALTER TABLE repair_requests
  ADD COLUMN IF NOT EXISTS flow TEXT NOT NULL DEFAULT 'DIRECT' CHECK (flow IN ('DIRECT', 'MARKETPLACE')),
  ADD COLUMN IF NOT EXISTS fulfilment TEXT CHECK (fulfilment IN ('PICKUP_DELIVERY', 'SHOP_VISIT')),
  ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_lat NUMERIC(10,8),
  ADD COLUMN IF NOT EXISTS customer_lng NUMERIC(11,8),
  ADD COLUMN IF NOT EXISTS customer_pincode VARCHAR(10),
  ADD COLUMN IF NOT EXISTS offers_close_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS selected_offer_id UUID,
  ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS review TEXT,
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_repair_req_open_market ON repair_requests (offers_close_at) WHERE flow = 'MARKETPLACE' AND status = 'REQUESTED';
CREATE INDEX IF NOT EXISTS idx_repair_req_rated ON repair_requests (assigned_vendor_id) WHERE rating IS NOT NULL;

-- ── Offers: one live offer per vendor per request ────────────────────────
CREATE TABLE IF NOT EXISTS repair_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('AUTO', 'MANUAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SELECTED', 'NOT_SELECTED', 'WITHDRAWN', 'EXPIRED')),
  lines JSONB NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  tax_pct NUMERIC(5,2) NOT NULL,
  tax_amount NUMERIC(12,2) NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  mrp_total NUMERIC(12,2),                    -- optional "was" price shown struck through
  est_days_min INTEGER NOT NULL DEFAULT 1,
  est_days_max INTEGER NOT NULL DEFAULT 2,
  warranty_days INTEGER NOT NULL DEFAULT 90,
  pickup_delivery BOOLEAN NOT NULL DEFAULT TRUE,
  shop_visit BOOLEAN NOT NULL DEFAULT TRUE,
  distance_km NUMERIC(8,2),
  note TEXT,
  valid_until TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, vendor_id),
  CHECK (est_days_max >= est_days_min)
);
CREATE INDEX IF NOT EXISTS idx_repair_offers_req ON repair_offers (request_id, status);
CREATE INDEX IF NOT EXISTS idx_repair_offers_vendor ON repair_offers (vendor_id, status, created_at DESC);

-- ── Repair vendor RBAC: price list is managed with the same permissions as repairs ──
-- (no new permission vocabulary: `repairs.manage` for staff; vendors manage their own list through vendor scope)
