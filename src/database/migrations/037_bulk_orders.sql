-- 037_bulk_orders.sql
-- Create bulk_orders table for multi-vendor large/scheduled-delivery orders.
-- A Bulk_Order is a Customer-placed large order targeting a single Shop with
-- a chosen delivery_date and delivery_slot, advancing through the lifecycle
-- DRAFT -> SUBMITTED -> CONFIRMED -> PROCESSING -> READY -> DELIVERED, with
-- CANCELLED reachable from DRAFT / SUBMITTED / CONFIRMED. Stock is validated
-- on submit, deducted on confirm, and restored on cancel-after-confirm by
-- the Bulk_Orders service inside a single transaction.

-- ═══════════════════════════════════════════════════════════════
-- 1. BULK_ORDERS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bulk_orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Identity
  order_number          VARCHAR(20) NOT NULL UNIQUE,

  -- Lifecycle
  status                VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                        CONSTRAINT chk_bulk_orders_status
                          CHECK (status IN (
                            'DRAFT',
                            'SUBMITTED',
                            'CONFIRMED',
                            'PROCESSING',
                            'READY',
                            'DELIVERED',
                            'CANCELLED'
                          )),

  -- Items
  items                 JSONB NOT NULL,
  total_items           INTEGER NOT NULL
                        CONSTRAINT chk_bulk_orders_total_items
                          CHECK (total_items >= 5),

  -- Money (Req 15.4: DECIMAL never FLOAT; widened to (12,2) for totals
  -- to accommodate Bulk_Order total_amount upper bound 999999.99)
  subtotal              DECIMAL(12,2) NOT NULL
                        CONSTRAINT chk_bulk_orders_subtotal
                          CHECK (subtotal >= 0),
  discount_amount       DECIMAL(10,2) NOT NULL DEFAULT 0
                        CONSTRAINT chk_bulk_orders_discount_amount
                          CHECK (discount_amount >= 0),
  delivery_fee          DECIMAL(10,2) NOT NULL DEFAULT 0
                        CONSTRAINT chk_bulk_orders_delivery_fee
                          CHECK (delivery_fee >= 0),
  total_amount          DECIMAL(12,2) NOT NULL
                        CONSTRAINT chk_bulk_orders_total_amount
                          CHECK (total_amount >= 0.01 AND total_amount <= 999999.99),

  -- Delivery
  delivery_date         DATE NULL,
  delivery_slot         VARCHAR(50) NULL,
  delivery_address      JSONB NOT NULL,

  -- Payment
  payment_method        VARCHAR(50) NULL,
  payment_status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Shop dashboard listing: a Shop's Bulk_Orders filtered by status
-- (powers Shop_Manager / Shop_Admin queue views).
CREATE INDEX IF NOT EXISTS idx_bulk_orders_shop_status
  ON bulk_orders (shop_id, status);

-- Customer history listing: a Customer's Bulk_Orders most recent first.
CREATE INDEX IF NOT EXISTS idx_bulk_orders_user_created_at
  ON bulk_orders (user_id, created_at DESC);

-- Slot/scheduling queries: lookups by delivery_date filtered by status
-- (powers fulfillment planning and slot capacity checks).
CREATE INDEX IF NOT EXISTS idx_bulk_orders_delivery_date_status
  ON bulk_orders (delivery_date, status);
