-- Migration 135: Vendor Procurement Supply Orders, Items & Timeline
-- Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §9, §17.1
-- Created when a fixed offer is accepted or an RFQ quote is awarded.
-- Commercial values are frozen at creation; only confirmed receipt touches inventory.

-- 1. Procurement Supply Orders
CREATE TABLE IF NOT EXISTS procurement_supply_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_number VARCHAR(30) UNIQUE NOT NULL,
  request_id UUID NOT NULL REFERENCES procurement_requests(id) ON DELETE RESTRICT,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  quote_id UUID REFERENCES procurement_quotes(id) ON DELETE SET NULL,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('FIXED_OFFER', 'RFQ')),
  status TEXT NOT NULL CHECK (status IN (
    'AWARDED', 'ACCEPTED', 'PROCESSING', 'CLEANING', 'VIDEO_SUBMITTED',
    'PACKED', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED_PENDING_RECEIPT',
    'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED_AT_RECEIPT'
  )) DEFAULT 'AWARDED',
  award_amount NUMERIC(12,2) NOT NULL CHECK (award_amount >= 0),
  promised_delivery_at TIMESTAMPTZ,
  dispatch_note TEXT,
  delivery_reference VARCHAR(100),
  vehicle_note TEXT,
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_procurement_supply_orders_vendor ON procurement_supply_orders(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_procurement_supply_orders_shop ON procurement_supply_orders(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_procurement_supply_orders_status ON procurement_supply_orders(status);

-- One request produces exactly one supply order (v1: no split awards, no re-award).
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_supply_order_per_request
  ON procurement_supply_orders(request_id);

-- 2. Procurement Supply Order Items
CREATE TABLE IF NOT EXISTS procurement_supply_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_id UUID NOT NULL REFERENCES procurement_supply_orders(id) ON DELETE CASCADE,
  request_item_id UUID REFERENCES procurement_request_items(id) ON DELETE SET NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  item_name VARCHAR(200) NOT NULL,
  agreed_quantity NUMERIC(10,2) NOT NULL CHECK (agreed_quantity > 0),
  unit TEXT NOT NULL CHECK (unit IN ('KG', 'PC', 'PACK', 'LTR')) DEFAULT 'KG',
  agreed_unit_price NUMERIC(10,2) NOT NULL CHECK (agreed_unit_price >= 0),
  agreed_line_total NUMERIC(12,2) NOT NULL CHECK (agreed_line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_supply_items_order ON procurement_supply_order_items(supply_order_id);

-- 3. Supply Timeline (append-only state history for stepper UI + state reconstruction)
CREATE TABLE IF NOT EXISTS procurement_supply_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_order_id UUID NOT NULL REFERENCES procurement_supply_orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_supply_events_order ON procurement_supply_events(supply_order_id, created_at);

-- 4. Automatic Timestamp Update Triggers
DROP TRIGGER IF EXISTS trg_procurement_supply_orders_updated_at ON procurement_supply_orders;
CREATE TRIGGER trg_procurement_supply_orders_updated_at
  BEFORE UPDATE ON procurement_supply_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_supply_items_updated_at ON procurement_supply_order_items;
CREATE TRIGGER trg_procurement_supply_items_updated_at
  BEFORE UPDATE ON procurement_supply_order_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
