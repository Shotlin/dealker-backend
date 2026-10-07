-- 045_shop_transactions_v2.sql
-- Multi-vendor: extend the existing append-only `shop_transactions` ledger
-- (migration 035) with the columns and CHECK vocabulary required by the
-- Transaction_Type_V2 universe. Together with the legacy values from
-- Requirement 7 AC#2, this migration is the storage substrate for
-- Requirement 24 (Extended Shop Transactions and Finance) and the
-- COUPON_DISCOUNT shop_transactions wiring introduced by Requirement 26
-- AC#10 (design §10.3) plus the settlement inserts in design §9.2.
--
-- Why this migration exists (R24 background):
--   * Legacy migration 035 modelled a single-vendor cost ledger with the
--     7-value Transaction_Type_V1 vocabulary
--     {ORDER_REVENUE, COMMISSION_DEBIT, DELIVERY_COST, REFUND_DEBIT,
--      PAYOUT_CREDIT, ADJUSTMENT, EXPENSE} and inferred the credit/debit
--     sign from `type` alone.
--   * R24 AC#1 introduces Transaction_Type_V2 — adding DELIVERY_FEE,
--     RIDER_COST, REFUND, PAYOUT, COUPON_DISCOUNT, TAX, and the merged
--     PLATFORM_COMMISSION — and R24 AC#2 demands an explicit `direction`
--     (CREDIT|DEBIT) column so a single transaction kind can be written
--     in either direction (the canonical example being PAYOUT, which
--     R24 AC#16 mandates be written with direction=DEBIT for new rows
--     while the legacy PAYOUT_CREDIT name is preserved as a read-only
--     alias).
--   * R24 AC#2 also requires per-row `status` (PENDING|POSTED|REVERSED,
--     default POSTED), `rider_id` (nullable, FK users — populated for
--     RIDER_COST settlement rows per design §9.2), and `metadata` JSONB
--     for free-form per-type context (coupon_code / coupon_type /
--     absorber for COUPON_DISCOUNT per design §10.3, tax_code /
--     tax_rate for TAX per R24 AC#6, payout_id for PAYOUT per R24 AC#8,
--     and the corrected_transaction_id reference used by ADJUSTMENT
--     corrections per R24 AC#3).
--   * Design §9.2 + §10.3 + §3.2.7 also expect a first-class `order_id`
--     UUID column (referenced as `INSERT INTO shop_transactions
--     (shop_id, order_id, amount, direction, type, status, created_by,
--     metadata) VALUES ...`) and the per-order partial index
--     `idx_shop_transactions_order (order_id) WHERE order_id IS NOT
--     NULL`. Migration 035 only carried `reference_type`/`reference_id`
--     so this migration adds `order_id` as well — without it the
--     §3.2.7 index creation would fail and R24 AC#2 would remain
--     unsatisfied. The legacy `reference_type`/`reference_id` columns
--     and `idx_shop_transactions_reference` index are left in place for
--     read-back compatibility (R24 AC#15).
--
-- Column extensions to `shop_transactions` (idempotent — every ALTER
-- uses IF NOT EXISTS; per design §3.2.7 + R24 AC#2):
--   * direction   VARCHAR(6) DEFAULT 'CREDIT'
--                   — explicit ledger direction. CHECK-constrained to
--                     CREDIT|DEBIT via `chk_shop_transactions_direction`
--                     below. Default keeps every legacy single-vendor
--                     row classified as a CREDIT without an explicit
--                     backfill; the legacy → V2 read-time normalization
--                     (`shop-transactions.repository.js#normalizeType`,
--                     design §9.1) is responsible for re-deriving the
--                     direction of legacy DEBIT rows
--                     (COMMISSION_DEBIT / DELIVERY_COST / REFUND_DEBIT
--                     / EXPENSE) from their type at read time.
--   * rider_id    UUID REFERENCES users(id)
--                   — the Rider whose RIDER_COST settlement row this
--                     is, per design §9.2. NULL for every other type
--                     and for legacy rows. Powers the per-rider
--                     partial index `idx_shop_transactions_rider`
--                     below (drives the rider earnings / settlement
--                     drill-down in the HQ + per-shop finance views).
--   * metadata    JSONB DEFAULT '{}'::jsonb
--                   — per-type free-form context (R24 AC#5, AC#6, AC#7,
--                     AC#8, R26 AC#10, design §9.2 + §10.3). Examples:
--                       COUPON_DISCOUNT → {coupon_id, coupon_code,
--                                          coupon_type, absorber}
--                       TAX             → {tax_code, tax_rate}
--                       PAYOUT          → {payout_id}
--                       REFUND          → {reason, operator}
--                       ADJUSTMENT      → {corrected_transaction_id,
--                                          period_id}
--                     Default empty object keeps legacy rows valid
--                     without an explicit backfill.
--   * status      VARCHAR(20) DEFAULT 'POSTED'
--                   — settlement state. CHECK-constrained to
--                     PENDING|POSTED|REVERSED via
--                     `chk_shop_transactions_status` below. Default
--                     keeps every legacy single-vendor row classified
--                     as POSTED without an explicit backfill (legacy
--                     rows were always written at settlement time).
--   * order_id    UUID REFERENCES orders(id)
--                   — the Order this row was emitted for, populated by
--                     the settlement inserts (design §9.2) and the
--                     COUPON_DISCOUNT inserts (design §10.3). NULL for
--                     PAYOUT, ADJUSTMENT, EXPENSE, and the legacy
--                     reference_id-keyed rows. Powers the per-order
--                     partial index `idx_shop_transactions_order`
--                     below; needed by the Property 5 ledger
--                     consistency invariant (design §17 "Validates:
--                     Requirements 7.7, 24.4") which sums per-order
--                     CREDITs minus DEBITs.
--
-- CHECK constraint replacement on `type` (per design §3.2.7 + R24 AC#1):
--   Migration 035 created `chk_shop_transactions_type` over the 7-value
--   Transaction_Type_V1 vocabulary. R24 AC#1 mandates a single CHECK
--   constraint covering the union of Transaction_Type_V2 and the legacy
--   values (the latter preserved for backward compatibility per
--   R24 AC#15). The DO $$ block below DROPs the legacy constraint if
--   present and re-ADDs it covering all 14 values:
--       Transaction_Type_V2:   ORDER_REVENUE, PLATFORM_COMMISSION,
--                              DELIVERY_FEE, RIDER_COST, REFUND,
--                              PAYOUT, ADJUSTMENT, COUPON_DISCOUNT,
--                              TAX
--       Legacy (read-only):    COMMISSION_DEBIT, DELIVERY_COST,
--                              REFUND_DEBIT, PAYOUT_CREDIT, EXPENSE
--   ORDER_REVENUE and ADJUSTMENT appear in both vocabularies and are
--   listed once. The DROP-then-ADD pattern is idempotent on re-run
--   because `pg_constraint` will only contain the new (V2-shaped)
--   constraint after the first pass; the second pass DROPs that same
--   constraint and re-ADDs an identical one, which is a no-op net
--   schema change.
--
-- New CHECK constraints on `shop_transactions` (per design §3.2.7 +
-- R24 AC#2):
--   * chk_shop_transactions_direction
--       — direction IN ('CREDIT','DEBIT').
--   * chk_shop_transactions_status
--       — status IN ('PENDING','POSTED','REVERSED').
--   Each constraint is created inside a `DO $$ ... END $$` block guarded
--   by a `pg_constraint` lookup so re-running the migration is a no-op
--   (no `duplicate_object` raised on the second pass).
--
-- Indexes on `shop_transactions` (per design §3.2.7):
--   * idx_shop_transactions_shop_type_created
--       — `(shop_id, type, created_at DESC)`. Re-declared here
--         alongside the V2 columns; `CREATE INDEX IF NOT EXISTS` makes
--         this a no-op if migration 035 already created the
--         identically-named index. Powers the type-filtered ledger
--         view used by the HQ + per-shop transaction listing endpoints
--         (design §6.6).
--   * idx_shop_transactions_order
--       — partial `(order_id) WHERE order_id IS NOT NULL`. Powers the
--         per-order ledger drill-down on the order detail page and the
--         Property 5 settlement-conservation invariant scan (design §17
--         "Validates: Requirements 7.7, 24.4") without bloating the
--         index with the (majority) non-order rows (PAYOUT,
--         ADJUSTMENT, EXPENSE, legacy reference_id-keyed rows).
--   * idx_shop_transactions_rider
--       — partial `(rider_id) WHERE rider_id IS NOT NULL`. Powers the
--         per-rider RIDER_COST drill-down used by the rider earnings /
--         settlement reports (design §9.2) without indexing the
--         majority (non-RIDER_COST) rows.
--
-- Append-only contract preserved (R24 AC#3, design §17 "Property 11"):
--   * The application path only INSERTs and SELECTs `shop_transactions`
--     — never UPDATE, never DELETE. Migration 035 already declared this
--     contract; this migration does not relax it. R24 AC#3 explicitly
--     reaffirms: corrections SHALL be performed solely by inserting a
--     new ADJUSTMENT row whose `metadata.references` contains the
--     corrected_transaction_id. The `metadata` JSONB column added here
--     is the storage for that reference.
--
-- Idempotent: re-running this migration is a no-op. Every column
-- addition uses `ADD COLUMN IF NOT EXISTS`, the type-CHECK swap is
-- guarded by a DO $$ block that DROPs the prior constraint only when
-- it exists, every new CHECK constraint is created inside a `DO $$`
-- block guarded by a `pg_constraint` lookup, and every index uses
-- `CREATE INDEX IF NOT EXISTS`.
--
-- Note: this migration only ships the schema. The settlement worker
-- inserts (R24 AC#4, design §9.2), the COUPON_DISCOUNT wiring (R26
-- AC#10, design §10.3), the TAX / REFUND / PAYOUT inserts (R24 AC#6,
-- AC#7, AC#8), the `normalizeType(row)` read-time helper that maps
-- legacy → V2 (R24 AC#15, design §9.1), the recalculation service for
-- ADJUSTMENT-driven corrections (R24 AC#14, design §9.4), and the
-- `transaction_posted` audit emission on every insert site (R24 AC#13,
-- design §12) all live in subsequent tasks.
--
-- Requirements: R24.1, R24.2, R24.15, R24.16
-- Design:       §3.2.7 of .kiro/specs/multi-vendor-system/design.md

ALTER TABLE shop_transactions ADD COLUMN IF NOT EXISTS direction VARCHAR(6)  DEFAULT 'CREDIT';
ALTER TABLE shop_transactions ADD COLUMN IF NOT EXISTS rider_id  UUID        REFERENCES users(id);
ALTER TABLE shop_transactions ADD COLUMN IF NOT EXISTS metadata  JSONB       DEFAULT '{}'::jsonb;
ALTER TABLE shop_transactions ADD COLUMN IF NOT EXISTS status    VARCHAR(20) DEFAULT 'POSTED';
ALTER TABLE shop_transactions ADD COLUMN IF NOT EXISTS order_id  UUID        REFERENCES orders(id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_shop_transactions_type') THEN
    ALTER TABLE shop_transactions DROP CONSTRAINT chk_shop_transactions_type;
  END IF;

  ALTER TABLE shop_transactions
    ADD CONSTRAINT chk_shop_transactions_type
    CHECK (type IN (
      'ORDER_REVENUE',
      'PLATFORM_COMMISSION',
      'DELIVERY_FEE',
      'RIDER_COST',
      'REFUND',
      'PAYOUT',
      'ADJUSTMENT',
      'COUPON_DISCOUNT',
      'TAX',
      'COMMISSION_DEBIT',
      'DELIVERY_COST',
      'REFUND_DEBIT',
      'PAYOUT_CREDIT',
      'EXPENSE'
    ));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_shop_transactions_direction'
  ) THEN
    ALTER TABLE shop_transactions
      ADD CONSTRAINT chk_shop_transactions_direction
      CHECK (direction IN ('CREDIT','DEBIT'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_shop_transactions_status'
  ) THEN
    ALTER TABLE shop_transactions
      ADD CONSTRAINT chk_shop_transactions_status
      CHECK (status IN ('PENDING','POSTED','REVERSED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shop_transactions_shop_type_created
  ON shop_transactions (shop_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_transactions_order
  ON shop_transactions (order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shop_transactions_rider
  ON shop_transactions (rider_id)
  WHERE rider_id IS NOT NULL;
