-- Migration 136: Vendor Procurement Evidence, Receipts & Vendor Supply Reviews
-- Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §10, §11, §12, §13, §17.1
-- Evidence backs the mandatory video gate before PACKED. Receipts hold the
-- requested/received/accepted/rejected variance; only accepted quantity later
-- reaches inventory through the existing inbound path.

-- 1. Procurement Evidence (quality/cleaning videos, packing/dispatch photos)
CREATE TABLE IF NOT EXISTS procurement_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_id UUID NOT NULL REFERENCES procurement_supply_orders(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('QUALITY_VIDEO', 'QUALITY_IMAGE', 'PACKING_IMAGE', 'DISPATCH_PROOF', 'OTHER')) DEFAULT 'QUALITY_VIDEO',
  media_public_id VARCHAR(255) NOT NULL,
  media_url VARCHAR(512) NOT NULL,
  mime_type VARCHAR(100),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  review_status TEXT CHECK (review_status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  review_comment TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_evidence_supply ON procurement_evidence(supply_order_id);
CREATE INDEX IF NOT EXISTS idx_procurement_evidence_type ON procurement_evidence(supply_order_id, evidence_type);

-- 2. Procurement Receipts (one receipt event per supply order in v1)
CREATE TABLE IF NOT EXISTS procurement_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_id UUID NOT NULL UNIQUE REFERENCES procurement_supply_orders(id) ON DELETE RESTRICT,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'REJECTED_AT_RECEIPT')) DEFAULT 'RECEIVED',
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_receipts_shop ON procurement_receipts(shop_id);

-- 3. Procurement Receipt Items (per-item variance; accepted goes to inventory)
CREATE TABLE IF NOT EXISTS procurement_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES procurement_receipts(id) ON DELETE CASCADE,
  supply_order_item_id UUID NOT NULL REFERENCES procurement_supply_order_items(id) ON DELETE RESTRICT,
  requested_quantity NUMERIC(10,2) NOT NULL CHECK (requested_quantity >= 0),
  received_quantity NUMERIC(10,2) NOT NULL CHECK (received_quantity >= 0),
  accepted_quantity NUMERIC(10,2) NOT NULL CHECK (accepted_quantity >= 0),
  rejected_quantity NUMERIC(10,2) NOT NULL CHECK (rejected_quantity >= 0),
  CONSTRAINT chk_receipt_accepted_plus_rejected CHECK (accepted_quantity + rejected_quantity <= received_quantity),
  issue_category TEXT CHECK (issue_category IN ('QUANTITY_SHORTAGE', 'QUALITY', 'FRESHNESS', 'CLEANING', 'PACKAGING', 'LATE_DELIVERY', 'DAMAGED', 'DOCUMENTATION', 'OTHER')),
  issue_note TEXT,
  inventory_lot_id UUID REFERENCES inventory_lots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_receipt_items_receipt ON procurement_receipt_items(receipt_id);

-- 4. Vendor Supply Reviews (post-receipt ratings + issue history)
CREATE TABLE IF NOT EXISTS vendor_supply_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_id UUID NOT NULL UNIQUE REFERENCES procurement_supply_orders(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  receipt_id UUID REFERENCES procurement_receipts(id) ON DELETE SET NULL,
  rated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rating_freshness SMALLINT NOT NULL CHECK (rating_freshness BETWEEN 1 AND 5),
  rating_cleaning SMALLINT NOT NULL CHECK (rating_cleaning BETWEEN 1 AND 5),
  rating_packaging SMALLINT NOT NULL CHECK (rating_packaging BETWEEN 1 AND 5),
  rating_quantity_accuracy SMALLINT NOT NULL CHECK (rating_quantity_accuracy BETWEEN 1 AND 5),
  rating_punctuality SMALLINT NOT NULL CHECK (rating_punctuality BETWEEN 1 AND 5),
  rating_overall SMALLINT NOT NULL CHECK (rating_overall BETWEEN 1 AND 5),
  comment TEXT,
  issue_category TEXT CHECK (issue_category IN ('QUANTITY_SHORTAGE', 'QUALITY', 'FRESHNESS', 'CLEANING', 'PACKAGING', 'LATE_DELIVERY', 'DAMAGED', 'DOCUMENTATION', 'OTHER')),
  issue_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_supply_reviews_vendor ON vendor_supply_reviews(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_supply_reviews_shop ON vendor_supply_reviews(shop_id);

-- 5. Automatic Timestamp Update Triggers
DROP TRIGGER IF EXISTS trg_procurement_evidence_updated_at ON procurement_evidence;
CREATE TRIGGER trg_procurement_evidence_updated_at
  BEFORE UPDATE ON procurement_evidence
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_receipts_updated_at ON procurement_receipts;
CREATE TRIGGER trg_procurement_receipts_updated_at
  BEFORE UPDATE ON procurement_receipts
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_receipt_items_updated_at ON procurement_receipt_items;
CREATE TRIGGER trg_procurement_receipt_items_updated_at
  BEFORE UPDATE ON procurement_receipt_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_vendor_supply_reviews_updated_at ON vendor_supply_reviews;
CREATE TRIGGER trg_vendor_supply_reviews_updated_at
  BEFORE UPDATE ON vendor_supply_reviews
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
