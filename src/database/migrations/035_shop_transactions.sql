-- 035_shop_transactions.sql
-- Create shop_transactions table: per-shop append-only financial ledger.
--
-- Stores immutable records of every financial event for a Shop (revenue,
-- commission, delivery cost, refund, payout, adjustment, expense). Each
-- row carries a precomputed `balance_after` that is the sum of all
-- preceding entries for the Shop, applied with sign by `type`:
--   credits (ORDER_REVENUE, PAYOUT_CREDIT, ADJUSTMENT)  → +amount
--   debits  (COMMISSION_DEBIT, DELIVERY_COST,
--            REFUND_DEBIT, EXPENSE)                     → −amount
-- Per req 7.7, balance_after MUST be computed under SELECT FOR UPDATE
-- on the shop's prior ledger row to prevent concurrent races.
--
-- ═══════════════════════════════════════════════════════════════
--  APPEND-ONLY INVARIANT (req 7.3, 7.4, 15.1)
-- ═══════════════════════════════════════════════════════════════
-- Rows in this table are IMMUTABLE. The Platform MUST never UPDATE or
-- DELETE existing shop_transactions records, and MUST NOT expose any
-- API endpoint that mutates them. Concretely:
--   * No `updated_at` column is defined (immutability is structural).
--   * The application layer is responsible for enforcing append-only
--     semantics (no UPDATE/DELETE statements in the shop-transactions
--     repository); this is verified by Property 11 (Ledger Immutability).
--   * Audit/correction events are recorded as new ADJUSTMENT rows, never
--     by mutating prior entries.
-- A failed insert MUST roll the whole financial operation back so the
-- pre-operation ledger state is preserved (req 7.9, 15.10).
--
-- Idempotent (req 15.8): CREATE TABLE / INDEX guarded by IF NOT EXISTS.

-- ═══════════════════════════════════════════════════════════════
-- 1. SHOP_TRANSACTIONS TABLE (append-only ledger)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_transactions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Event classification
  type                  VARCHAR(30) NOT NULL
                        CONSTRAINT chk_shop_transactions_type
                          CHECK (type IN (
                            'ORDER_REVENUE',
                            'COMMISSION_DEBIT',
                            'DELIVERY_COST',
                            'REFUND_DEBIT',
                            'PAYOUT_CREDIT',
                            'ADJUSTMENT',
                            'EXPENSE'
                          )),

  -- Amounts (always non-negative; sign is implied by `type`)
  amount                DECIMAL(10,2) NOT NULL
                        CONSTRAINT chk_shop_transactions_amount
                          CHECK (amount >= 0.01 AND amount <= 99999999.99),

  -- Running balance after this entry is applied.
  -- Wider precision than `amount` to safely accumulate many events.
  balance_after         DECIMAL(12,2) NOT NULL,

  -- Cross-reference to originating record (order, payout, etc.)
  reference_type        VARCHAR(30) NOT NULL
                        CONSTRAINT chk_shop_transactions_reference_type
                          CHECK (reference_type IN (
                            'ORDER',
                            'PAYOUT',
                            'ADJUSTMENT',
                            'EXPENSE'
                          )),
  reference_id          UUID NULL,

  -- Free-text context (capped to 500 chars per req 7.1)
  description           TEXT NULL
                        CONSTRAINT chk_shop_transactions_description_length
                          CHECK (description IS NULL OR LENGTH(description) <= 500),

  -- Actor (NULL for system-initiated events; preserved on user deletion)
  created_by            UUID NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Timestamps (no updated_at — rows are immutable, req 7.3 / 15.1)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Primary ledger read pattern: "show a shop's ledger, newest first".
-- Also serves the SELECT FOR UPDATE used to fetch the prior balance
-- when appending a new entry (req 7.7).
CREATE INDEX IF NOT EXISTS idx_shop_transactions_shop_created
  ON shop_transactions (shop_id, created_at DESC);

-- Filtered ledger reads (e.g. show only PAYOUT_CREDIT entries for a shop).
CREATE INDEX IF NOT EXISTS idx_shop_transactions_shop_type_created
  ON shop_transactions (shop_id, type, created_at DESC);

-- Cross-reference lookup: "find ledger entries linked to this order/payout".
CREATE INDEX IF NOT EXISTS idx_shop_transactions_reference
  ON shop_transactions (reference_type, reference_id);
