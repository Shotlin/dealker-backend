-- 041_shop_products_approval.sql
-- Multi-vendor: extend `shop_products` with the optional HQ approval workflow
-- introduced by Requirement 23 (manual product creation + master-catalog
-- governance). The workflow is opt-in via the env feature flag
-- `MULTI_VENDOR_PRODUCT_APPROVAL` (default false) — see R23 AC#10. When the
-- flag is OFF (current behavior) every newly created Shop_Product is born
-- APPROVED and customers see it as soon as `is_available=true AND
-- stock_quantity > 0`. When the flag is ON, manually created Shop_Products
-- are persisted with approval_status=PENDING and stay hidden from
-- customer-facing queries until an HQ_User with `shop_products.approve`
-- approves or rejects them (R23 AC#11, AC#22, AC#23).
--
-- Adds four columns to `shop_products` (idempotent — uses IF NOT EXISTS):
--   * approval_status   VARCHAR(10)   — current approval state.
--                                       DEFAULT 'APPROVED' so all
--                                       pre-existing rows stay visible
--                                       without an explicit backfill
--                                       (R23 AC#10 / design §3.2.3
--                                       backward-compat note). CHECK-
--                                       constrained vocabulary:
--                                       PENDING, APPROVED, REJECTED.
--   * approved_at       TIMESTAMPTZ   — set when an HQ_User approves the
--                                       Shop_Product (R23 AC#11).
--   * approved_by       UUID          — FK → users(id); the HQ_User who
--                                       performed the last approval/reject
--                                       transition (R23 AC#11).
--   * rejection_reason  VARCHAR(500)  — operator-supplied reason captured
--                                       on reject; the corresponding API
--                                       (POST /api/v1/admin/shop-products/:id/reject)
--                                       enforces a 10–500 char range
--                                       (R23 AC#11).
--
-- Default behavior (R23 AC#23): with `MULTI_VENDOR_PRODUCT_APPROVAL=false`
-- the column default of 'APPROVED' means no backfill UPDATE is required —
-- every existing row already satisfies the new CHECK constraint and remains
-- visible to customers exactly as before.
--
-- Adds one supporting partial index (per design §3.2.3):
--   * idx_shop_products_approval — `(shop_id, approval_status) WHERE
--                                   deleted_at IS NULL`. Powers the HQ
--                                   "products awaiting approval" queue
--                                   without bloating the primary
--                                   shop_products lookup index.
--
-- Idempotent: re-running this migration is a no-op. The CHECK constraint
-- is created inside a DO block guarded by a pg_constraint lookup so the
-- second run does not raise `duplicate_object`.
--
-- Note: this migration only ships the schema. The approve/reject
-- endpoints, the manual-create wiring that writes approval_status from
-- the feature flag, and the customer-facing query gate live in tasks
-- 6.1–6.8 (Phase C) and §17.3 of design.md respectively.
--
-- Requirements: R23.10, R23.11, R23.22, R23.23
-- Design:       §3.2.3 of .kiro/specs/multi-vendor-system/design.md

ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS approval_status VARCHAR(10) DEFAULT 'APPROVED';
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_shop_products_approval_status'
  ) THEN
    ALTER TABLE shop_products
      ADD CONSTRAINT chk_shop_products_approval_status
      CHECK (approval_status IN ('PENDING','APPROVED','REJECTED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shop_products_approval
  ON shop_products (shop_id, approval_status)
  WHERE deleted_at IS NULL;
