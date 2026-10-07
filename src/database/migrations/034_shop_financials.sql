-- 034_shop_financials.sql
-- Create shop_financials table for multi-vendor settlement and payout tracking.
-- Stores aggregated revenue, commission, delivery costs, refunds, and payout
-- state per shop per period (DAILY / WEEKLY / MONTHLY). Settlement_Worker
-- writes daily rows nightly; weekly/monthly rows are computed when their
-- period ends. Payout_Worker advances payout_status PENDING -> PROCESSING ->
-- PAID (or HELD on failure / missing bank details).

-- ═══════════════════════════════════════════════════════════════
-- 1. SHOP_FINANCIALS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_financials (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Period
  period_type           VARCHAR(10) NOT NULL
                        CONSTRAINT chk_shop_financials_period_type
                          CHECK (period_type IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  period_start          DATE NOT NULL,
  period_end            DATE NOT NULL,

  -- Revenue aggregates
  gross_revenue         DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_revenue           DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_orders          INTEGER NOT NULL DEFAULT 0
                        CONSTRAINT chk_shop_financials_total_orders
                          CHECK (total_orders >= 0),
  avg_order_value       DECIMAL(10,2) NOT NULL DEFAULT 0,

  -- Cost aggregates
  platform_commission   DECIMAL(10,2) NOT NULL DEFAULT 0,
  delivery_costs        DECIMAL(10,2) NOT NULL DEFAULT 0,
  refund_amount         DECIMAL(10,2) NOT NULL DEFAULT 0,

  -- Payout
  payout_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  payout_status         VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                        CONSTRAINT chk_shop_financials_payout_status
                          CHECK (payout_status IN ('PENDING', 'PROCESSING', 'PAID', 'HELD')),
  payout_ref            VARCHAR(100) NULL,
  paid_at               TIMESTAMPTZ NULL,
  failure_reason        TEXT NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0
                        CONSTRAINT chk_shop_financials_attempt_count
                          CHECK (attempt_count >= 0),

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT uq_shop_financials_shop_period
    UNIQUE (shop_id, period_type, period_start)
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Listing index: fetch a shop's financial records for a given period_type
-- ordered most recent first (powers Shop_Admin / Super_Admin financial views).
CREATE INDEX IF NOT EXISTS idx_shop_financials_shop_period_start
  ON shop_financials (shop_id, period_type, period_start DESC);

-- Partial index for the Payout_Worker: scans only PENDING rows when picking
-- up payout candidates each Monday.
CREATE INDEX IF NOT EXISTS idx_shop_financials_payout_status_pending
  ON shop_financials (payout_status)
  WHERE payout_status = 'PENDING';
