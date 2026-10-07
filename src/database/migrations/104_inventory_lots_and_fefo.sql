-- Migration 104: Inventory Lots, Stock Ledger & FEFO Reservations
-- Source of truth: Blueprint §06.5, Phase 6

-- 1. Inventory Lots Table
CREATE TABLE IF NOT EXISTS inventory_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES procurement_batches(id) ON DELETE SET NULL,
  batch_number VARCHAR(100) NOT NULL,
  expiry_date DATE NOT NULL,
  quantity_on_hand NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (quantity_on_hand >= 0),
  quantity_reserved NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (quantity_reserved >= 0),
  quantity_available NUMERIC(10,2) GENERATED ALWAYS AS (quantity_on_hand - quantity_reserved) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lot_warehouse_product_batch UNIQUE (warehouse_id, product_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_lots_fefo ON inventory_lots(warehouse_id, product_id, expiry_date ASC) WHERE (quantity_on_hand - quantity_reserved) > 0;
CREATE INDEX IF NOT EXISTS idx_lots_warehouse ON inventory_lots(warehouse_id);

-- 2. Stock Ledger Entries Table (Append-Only)
CREATE TABLE IF NOT EXISTS stock_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('INBOUND', 'OUTBOUND', 'ADJUSTMENT', 'TRANSFER', 'RESERVATION', 'RELEASE')),
  quantity_change NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(10,2) NOT NULL,
  reference_type VARCHAR(100),
  reference_id UUID,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_lot ON stock_ledger_entries(lot_id);
CREATE INDEX IF NOT EXISTS idx_ledger_warehouse ON stock_ledger_entries(warehouse_id);

-- 3. Stock Reservations Table
CREATE TABLE IF NOT EXISTS stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_key VARCHAR(255) NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  quantity_reserved NUMERIC(10,2) NOT NULL CHECK (quantity_reserved > 0),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'RELEASED', 'CONSUMED')) DEFAULT 'RESERVED',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservations_key ON stock_reservations(reservation_key);
CREATE INDEX IF NOT EXISTS idx_reservations_lot ON stock_reservations(lot_id);

-- 4. Stock Adjustments Table
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  quantity_change NUMERIC(10,2) NOT NULL,
  reason TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adjustments_lot ON stock_adjustments(lot_id);

-- 5. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_inventory_lots_updated_at ON inventory_lots;
CREATE TRIGGER trg_inventory_lots_updated_at
  BEFORE UPDATE ON inventory_lots
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_stock_reservations_updated_at ON stock_reservations;
CREATE TRIGGER trg_stock_reservations_updated_at
  BEFORE UPDATE ON stock_reservations
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
