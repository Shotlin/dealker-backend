-- Migration 102: Warehouse Receipts, Quality Control & Inspections
-- Source of truth: Blueprint §06.4, Phase 5A

-- 0. Warehouses and Zones (Pre-requisites)
CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  pincode TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  service_radius_km NUMERIC(8,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warehouse_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  zone_type TEXT NOT NULL, -- RECEIVING | STORAGE_COLD | STORAGE_DRY | PACKING | DISPATCH
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Warehouse Receipts Table
CREATE TABLE IF NOT EXISTS warehouse_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  procurement_order_id UUID REFERENCES procurement_orders(id) ON DELETE SET NULL,
  receipt_number VARCHAR(100) UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_RECEIPT', 'RECEIVING', 'QC_PENDING', 'QC_APPROVED', 'RECEIVED', 'QC_REJECTED', 'RETURNED')) DEFAULT 'PENDING_RECEIPT',
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_warehouse ON warehouse_receipts(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON warehouse_receipts(status);

-- 2. Warehouse Receipt Items Table
CREATE TABLE IF NOT EXISTS warehouse_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_receipt_id UUID NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES procurement_batches(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity_received NUMERIC(10,2) NOT NULL CHECK (quantity_received > 0),
  quantity_accepted NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (quantity_accepted >= 0),
  quantity_rejected NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (quantity_rejected >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON warehouse_receipt_items(warehouse_receipt_id);

-- 3. Quality Inspections Table
CREATE TABLE IF NOT EXISTS quality_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_receipt_id UUID NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  inspector_id UUID REFERENCES users(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'CONDITIONAL_PASS')) DEFAULT 'PASS',
  notes TEXT,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qc_inspections_receipt ON quality_inspections(warehouse_receipt_id);

-- 4. Quality Inspection Results Table
CREATE TABLE IF NOT EXISTS quality_inspection_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_inspection_id UUID NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  receipt_item_id UUID NOT NULL REFERENCES warehouse_receipt_items(id) ON DELETE CASCADE,
  parameter_name VARCHAR(100) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')) DEFAULT 'PASS',
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qc_results_inspection ON quality_inspection_results(quality_inspection_id);

-- 5. Warehouse Receipt Audit Logs Table
CREATE TABLE IF NOT EXISTS warehouse_receipt_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_receipt_id UUID NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipt_audits_receipt ON warehouse_receipt_audits(warehouse_receipt_id);

-- 6. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_warehouse_receipts_updated_at ON warehouse_receipts;
CREATE TRIGGER trg_warehouse_receipts_updated_at
  BEFORE UPDATE ON warehouse_receipts
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_warehouse_receipt_items_updated_at ON warehouse_receipt_items;
CREATE TRIGGER trg_warehouse_receipt_items_updated_at
  BEFORE UPDATE ON warehouse_receipt_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_quality_inspections_updated_at ON quality_inspections;
CREATE TRIGGER trg_quality_inspections_updated_at
  BEFORE UPDATE ON quality_inspections
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
