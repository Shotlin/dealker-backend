-- Migration 100: Procurement Orders, Goods Receipt & Batches
-- Source of truth: Blueprint §06.3, Phase 4A

-- 1. Procurement Orders Table
CREATE TABLE IF NOT EXISTS procurement_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_number VARCHAR(100) UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')) DEFAULT 'DRAFT',
  total_cost NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_procurement_vendor ON procurement_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_procurement_status ON procurement_orders(status);

-- 2. Procurement Items Table
CREATE TABLE IF NOT EXISTS procurement_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id UUID NOT NULL REFERENCES procurement_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity_ordered NUMERIC(10,2) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (quantity_received >= 0),
  unit_cost NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_items_order ON procurement_items(procurement_order_id);

-- 3. Procurement Batches Table
CREATE TABLE IF NOT EXISTS procurement_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id UUID NOT NULL REFERENCES procurement_orders(id) ON DELETE CASCADE,
  procurement_item_id UUID REFERENCES procurement_items(id) ON DELETE CASCADE,
  batch_number VARCHAR(100) UNIQUE NOT NULL,
  quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  manufactured_date DATE,
  expiry_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_batches_order ON procurement_batches(procurement_order_id);
CREATE INDEX IF NOT EXISTS idx_procurement_batches_number ON procurement_batches(batch_number);

-- 4. Procurement Media Evidence Table
CREATE TABLE IF NOT EXISTS procurement_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id UUID NOT NULL REFERENCES procurement_orders(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE', 'INVOICE', 'PDF', 'CERTIFICATE', 'DELIVERY_NOTE', 'EVIDENCE_OTHER')),
  file_key VARCHAR(255) NOT NULL,
  file_url VARCHAR(512),
  mime_type VARCHAR(100),
  size BIGINT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_media_order ON procurement_media(procurement_order_id);

-- 5. Procurement Audit Logs Table
CREATE TABLE IF NOT EXISTS procurement_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id UUID NOT NULL REFERENCES procurement_orders(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_audits_order ON procurement_audit_logs(procurement_order_id);

-- 6. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_procurement_orders_updated_at ON procurement_orders;
CREATE TRIGGER trg_procurement_orders_updated_at
  BEFORE UPDATE ON procurement_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_items_updated_at ON procurement_items;
CREATE TRIGGER trg_procurement_items_updated_at
  BEFORE UPDATE ON procurement_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_procurement_batches_updated_at ON procurement_batches;
CREATE TRIGGER trg_procurement_batches_updated_at
  BEFORE UPDATE ON procurement_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
