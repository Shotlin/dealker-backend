-- 036_scheduled_orders.sql
-- Create scheduled_orders table for customer-scheduled future and recurring orders.
-- A Scheduled_Order captures the cart snapshot (items, subtotal, delivery address,
-- payment method) plus a scheduled_for time and an optional recurrence
-- (repeat_type / repeat_until). The Scheduled_Orders_Worker picks up rows whose
-- scheduled_for has arrived (status='SCHEDULED'), advances them through
-- PROCESSING -> PLACED (linking placed_order_id) or PROCESSING -> FAILED. Customers
-- may CANCEL from SCHEDULED or FAILED.

-- ═══════════════════════════════════════════════════════════════
-- 1. SCHEDULED_ORDERS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scheduled_orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Cart snapshot
  items                 JSONB NOT NULL,
  subtotal              DECIMAL(10,2) NOT NULL
                        CONSTRAINT chk_scheduled_orders_subtotal
                          CHECK (subtotal >= 0),
  delivery_address      JSONB NOT NULL,
  payment_method        VARCHAR(50) NOT NULL DEFAULT 'COD',

  -- Schedule / recurrence
  scheduled_for         TIMESTAMPTZ NOT NULL,
  repeat_type           VARCHAR(20) NOT NULL DEFAULT 'ONCE'
                        CONSTRAINT chk_scheduled_orders_repeat_type
                          CHECK (repeat_type IN ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY')),
  repeat_until          TIMESTAMPTZ NULL,

  -- Lifecycle
  status                VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED'
                        CONSTRAINT chk_scheduled_orders_status
                          CHECK (status IN ('SCHEDULED', 'PROCESSING', 'PLACED', 'FAILED', 'CANCELLED')),
  placed_order_id       UUID NULL REFERENCES orders(id) ON DELETE SET NULL,
  failure_reason        TEXT NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Customer dashboard: list a customer's scheduled orders, filtered by status
-- (e.g. active SCHEDULED rows, history of PLACED/FAILED/CANCELLED).
CREATE INDEX IF NOT EXISTS idx_scheduled_orders_user_status
  ON scheduled_orders (user_id, status);

-- Scheduled_Orders_Worker tick: scans only rows still SCHEDULED whose
-- scheduled_for has arrived. Partial index keeps it tight as PLACED /
-- CANCELLED / FAILED rows accumulate over time.
CREATE INDEX IF NOT EXISTS idx_scheduled_orders_due
  ON scheduled_orders (scheduled_for, status)
  WHERE status = 'SCHEDULED';

-- Shop-scoped queries (e.g. shop-side reporting on upcoming scheduled
-- orders or cleanup when a shop is deactivated).
CREATE INDEX IF NOT EXISTS idx_scheduled_orders_shop_id
  ON scheduled_orders (shop_id);
