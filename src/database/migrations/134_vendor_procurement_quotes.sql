-- Migration 134: Vendor Procurement Quotes & Quote Items (RFQ mode)
-- Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §7.2, §8.3, §17.1
-- A quote is only valid from a persisted recipient of the request (FK to
-- procurement_recipients enforces targeting; service enforces deadline/vendor status).

-- 1. Procurement Quotes
CREATE TABLE IF NOT EXISTS procurement_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES procurement_recipients(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'UPDATED', 'SELECTED', 'NOT_SELECTED', 'WITHDRAWN', 'EXPIRED')) DEFAULT 'SUBMITTED',
  grand_total NUMERIC(12,2) NOT NULL CHECK (grand_total >= 0),
  promised_delivery_at TIMESTAMPTZ,
  note TEXT,
  validity_until TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_quotes_request ON procurement_quotes(request_id);
CREATE INDEX IF NOT EXISTS idx_procurement_quotes_vendor ON procurement_quotes(vendor_id);
CREATE INDEX IF NOT EXISTS idx_procurement_quotes_status ON procurement_quotes(status);
CREATE INDEX IF NOT EXISTS idx_procurement_quotes_request_status ON procurement_quotes(request_id, status);

-- Exactly one SELECTED (winning) quote per request.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_selected_quote_per_request
  ON procurement_quotes(request_id)
  WHERE status = 'SELECTED';

-- 2. Procurement Quote Items
CREATE TABLE IF NOT EXISTS procurement_quote_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES procurement_quotes(id) ON DELETE CASCADE,
  request_item_id UUID NOT NULL REFERENCES procurement_request_items(id) ON DELETE RESTRICT,
  quoted_quantity NUMERIC(10,2) NOT NULL CHECK (quoted_quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_quote_items_quote ON procurement_quote_items(quote_id);
CREATE INDEX IF NOT EXISTS idx_procurement_quote_items_request_item ON procurement_quote_items(request_item_id);

-- 3. Automatic Timestamp Update Triggers
DROP TRIGGER IF EXISTS trg_procurement_quotes_updated_at ON procurement_quotes;
CREATE TRIGGER trg_procurement_quotes_updated_at
  BEFORE UPDATE ON procurement_quotes
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_quote_items_updated_at ON procurement_quote_items;
CREATE TRIGGER trg_procurement_quote_items_updated_at
  BEFORE UPDATE ON procurement_quote_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
