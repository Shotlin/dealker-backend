-- Migration 106: Customer Orders, 17-State Machine & Fulfilment Workflow
-- Source of truth: Blueprint §06.7, Phase 8

-- Alter orders table to match Phase 8 requirements
DROP INDEX IF EXISTS idx_orders_analytics;

DO $$
BEGIN
  -- Rename user_id to customer_id if exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='user_id') THEN
    ALTER TABLE orders RENAME COLUMN user_id TO customer_id;
  END IF;

  -- Rename total_amount to total_payable if exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='total_amount') THEN
    ALTER TABLE orders RENAME COLUMN total_amount TO total_payable;
  END IF;

  -- Change status type to TEXT if it is not already
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='status' AND data_type='USER-DEFINED') THEN
    ALTER TABLE orders ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE orders ALTER COLUMN status TYPE TEXT USING status::text;
    ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'ORDER_PLACED';
  END IF;
END $$;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES checkout_quotes(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redeemed_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_warehouse ON orders(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_analytics ON orders(created_at, status) WHERE status NOT IN ('CANCELLED', 'REFUNDED');

-- Alter order_items table to match Phase 8 requirements
DO $$
BEGIN
  -- Rename name to product_name if exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='name') THEN
    ALTER TABLE order_items RENAME COLUMN name TO product_name;
  END IF;

  -- Rename price to unit_price if exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='price') THEN
    ALTER TABLE order_items RENAME COLUMN price TO unit_price;
  END IF;

  -- Rename total to subtotal if exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='total') THEN
    ALTER TABLE order_items RENAME COLUMN total TO subtotal;
  END IF;
END $$;

ALTER TABLE order_items ALTER COLUMN quantity TYPE NUMERIC(10,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- 3. Order Status History Table (Append-Only)
CREATE TABLE IF NOT EXISTS order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_hist_order ON order_status_history(order_id);

-- 4. Fulfilment Tasks Table
CREATE TABLE IF NOT EXISTS fulfilment_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('PICKING', 'PACKING')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')) DEFAULT 'PENDING',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fulfilment_tasks_order ON fulfilment_tasks(order_id);

-- 5. Order Audit Logs Table (Append-Only)
CREATE TABLE IF NOT EXISTS order_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_audits_order ON order_audit_logs(order_id);

-- 6. Automatic Timestamp Triggers
DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_order_items_updated_at ON order_items;
CREATE TRIGGER trg_order_items_updated_at
  BEFORE UPDATE ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_fulfilment_tasks_updated_at ON fulfilment_tasks;
CREATE TRIGGER trg_fulfilment_tasks_updated_at
  BEFORE UPDATE ON fulfilment_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
