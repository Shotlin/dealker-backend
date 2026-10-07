-- 159_vendor_settlements.sql
-- Append-only settlement ledger per seller order. Every balance is
-- reconstructable by summing ledger entries; balances are never mutated
-- outside the ledger.

CREATE TABLE IF NOT EXISTS settlement_ledger (
  id BIGSERIAL PRIMARY KEY,
  seller_order_id UUID REFERENCES seller_orders(id) ON DELETE SET NULL,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL
    CHECK (entry_type IN (
      'GROSS_SALES',            -- item subtotal of the seller order
      'SELLER_DISCOUNT',        -- seller-funded discount (negative)
      'PLATFORM_DISCOUNT',      -- platform-funded discount (reimbursed, positive)
      'COMMISSION',             -- platform commission (negative)
      'LOGISTICS',              -- logistics charge allocation (negative)
      'REFUND',                 -- return/refund deduction (negative)
      'PENALTY',                -- policy penalty (negative)
      'ADJUSTMENT',             -- manual admin adjustment (+/-)
      'INCENTIVE',              -- platform incentive (positive)
      'PAYOUT'                  -- money actually paid out (negative)
    )),
  amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  balance_after NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  reason TEXT,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(100) UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_ledger_vendor ON settlement_ledger(vendor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_settlement_ledger_seller_order ON settlement_ledger(seller_order_id) WHERE seller_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS settlement_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  payout_number VARCHAR(30) NOT NULL UNIQUE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED')),
  period_start DATE,
  period_end DATE,
  utr_number VARCHAR(60),
  paid_at TIMESTAMP,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_payouts_vendor ON settlement_payouts(vendor_id);

CREATE TABLE IF NOT EXISTS settlement_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  seller_order_id UUID REFERENCES seller_orders(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_holds_vendor ON settlement_holds(vendor_id) WHERE is_active = TRUE;

COMMENT ON TABLE settlement_ledger IS 'Append-only vendor settlement ledger. payable_to_seller on seller_orders is a derived cache; the ledger is authoritative.';
