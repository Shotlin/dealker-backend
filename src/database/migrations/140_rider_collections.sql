-- 140_rider_collections.sql
-- COD money state becomes server-authoritative (blueprint Big Phase 14):
-- the rider's cash/UPI collection is persisted per order, duplicate
-- postings are impossible at the constraint level, and cash handover is
-- reconciled through settlements.
--
-- amount_due is snapshotted at collection time (what the rider was told
-- to collect) — order rows can be edited later, the audit trail must
-- not move.

CREATE TABLE IF NOT EXISTS delivery_collections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rider_id        UUID NOT NULL REFERENCES users(id),
  amount_due      DECIMAL(10,2) NOT NULL,
  cash_amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
  upi_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_collected DECIMAL(10,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'COLLECTED'
                  CHECK (status IN ('COLLECTED', 'SETTLED')),
  idempotency_key VARCHAR(100) NOT NULL,
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One authoritative collection per order: a retry (same key, same
  -- amounts) replays; a different-keyed second post hits this
  -- constraint and 409s.
  CONSTRAINT uq_delivery_collections_order UNIQUE (order_id),
  CONSTRAINT uq_delivery_collections_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_delivery_collections_total
    CHECK (total_collected >= 0
           AND cash_amount >= 0
           AND upi_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_delivery_collections_rider
  ON delivery_collections (rider_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_collections_settlement
  ON delivery_collections (rider_id, status)
  WHERE status = 'COLLECTED';

-- Cash handover: an admin records money physically received from the
-- rider; the settlement flow flips the rider's COLLECTED cash rows to
-- SETTLED inside the same transaction.
CREATE TABLE IF NOT EXISTS rider_cash_settlements (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id    UUID NOT NULL REFERENCES users(id),
  amount      DECIMAL(10,2) NOT NULL,
  method      VARCHAR(20) NOT NULL DEFAULT 'CASH'
              CHECK (method IN ('CASH', 'BANK_TRANSFER', 'UPI')),
  reference   VARCHAR(200),
  status      VARCHAR(20) NOT NULL DEFAULT 'SETTLED'
              CHECK (status IN ('SETTLED', 'PENDING')),
  settled_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_cash_settlements_rider
  ON rider_cash_settlements (rider_id, created_at DESC);

-- Business UPI id the rider's collect sheet builds its QR from —
-- dashboard-managed like the Ola key; the app only ever reads it.
ALTER TABLE rider_profiles
  ADD COLUMN IF NOT EXISTS business_upi_id VARCHAR(100);
