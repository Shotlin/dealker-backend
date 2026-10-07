-- Migration 133: Vendor Procurement Requests, Request Items & Recipients
-- Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §6, §7, §8, §17.1
-- Store-first procurement requests (FIXED_OFFER first-accept / RFQ quotation).
-- Distinct from the internal purchase-order flow in migration 100 (procurement_orders).

-- 1. Procurement Requests (header)
CREATE TABLE IF NOT EXISTS procurement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number VARCHAR(30) UNIQUE NOT NULL,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('FIXED_OFFER', 'RFQ')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'AWARDED', 'IN_FULFILMENT', 'COMPLETED', 'CANCELLED', 'EXPIRED')) DEFAULT 'DRAFT',
  title VARCHAR(200) NOT NULL,
  required_delivery_at TIMESTAMPTZ,
  response_deadline TIMESTAMPTZ,
  notes TEXT,
  quality_instructions TEXT,
  substitutes_allowed BOOLEAN NOT NULL DEFAULT false,
  offer_total NUMERIC(12,2) CHECK (offer_total IS NULL OR offer_total >= 0),
  awarded_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  awarded_at TIMESTAMPTZ,
  award_total NUMERIC(12,2) CHECK (award_total IS NULL OR award_total >= 0),
  published_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_procurement_requests_shop ON procurement_requests(shop_id);
CREATE INDEX IF NOT EXISTS idx_procurement_requests_status ON procurement_requests(status);
CREATE INDEX IF NOT EXISTS idx_procurement_requests_mode ON procurement_requests(mode);
CREATE INDEX IF NOT EXISTS idx_procurement_requests_deadline ON procurement_requests(response_deadline);
CREATE INDEX IF NOT EXISTS idx_procurement_requests_awarded_vendor ON procurement_requests(awarded_vendor_id) WHERE awarded_vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_procurement_requests_shop_status ON procurement_requests(shop_id, status) WHERE deleted_at IS NULL;

-- 2. Procurement Request Items
CREATE TABLE IF NOT EXISTS procurement_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  item_name VARCHAR(200) NOT NULL,
  requested_quantity NUMERIC(10,2) NOT NULL CHECK (requested_quantity > 0),
  unit TEXT NOT NULL CHECK (unit IN ('KG', 'PC', 'PACK', 'LTR')) DEFAULT 'KG',
  spec_note TEXT,
  fixed_unit_price NUMERIC(10,2) CHECK (fixed_unit_price IS NULL OR fixed_unit_price >= 0),
  fixed_line_total NUMERIC(12,2) CHECK (fixed_line_total IS NULL OR fixed_line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_request_items_request ON procurement_request_items(request_id);
CREATE INDEX IF NOT EXISTS idx_procurement_request_items_category ON procurement_request_items(category_id);

-- 3. Procurement Recipients (persisted targeting snapshot; why a vendor was eligible)
CREATE TABLE IF NOT EXISTS procurement_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('NEW', 'VIEWED', 'DECLINED', 'RESPONDED', 'AWARDED', 'NOT_SELECTED', 'EXPIRED')) DEFAULT 'NEW',
  eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  viewed_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_procurement_recipient UNIQUE (request_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_procurement_recipients_vendor ON procurement_recipients(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_procurement_recipients_request ON procurement_recipients(request_id);

-- 4. Automatic Timestamp Update Triggers
DROP TRIGGER IF EXISTS trg_procurement_requests_updated_at ON procurement_requests;
CREATE TRIGGER trg_procurement_requests_updated_at
  BEFORE UPDATE ON procurement_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_request_items_updated_at ON procurement_request_items;
CREATE TRIGGER trg_procurement_request_items_updated_at
  BEFORE UPDATE ON procurement_request_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_recipients_updated_at ON procurement_recipients;
CREATE TRIGGER trg_procurement_recipients_updated_at
  BEFORE UPDATE ON procurement_recipients
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
