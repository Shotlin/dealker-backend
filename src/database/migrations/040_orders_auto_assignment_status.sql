-- 040_orders_auto_assignment_status.sql
-- Multi-vendor: extend `orders` to track the rider auto-assignment outcome
-- so HQ operators can triage orders that need a manual rider pick.
--
-- Adds one column to `orders` (idempotent — uses IF NOT EXISTS):
--   * auto_assignment_status VARCHAR(20) — current auto-assignment lifecycle
--                                          state. NULL for legacy orders that
--                                          predate the multi-vendor rollout
--                                          (R25 AC#5 only mandates a value
--                                          when the assignment job runs).
--                                          CHECK-constrained vocabulary:
--                                          PENDING, ASSIGNED,
--                                          MANUAL_REQUIRED, FAILED.
--
-- Status semantics (per design §3.2.2 + R25 AC#5):
--   * PENDING          — order accepted by the shop; auto-assignment job has
--                        not yet picked a rider.
--   * ASSIGNED         — auto-assignment succeeded; a rider has been linked
--                        through delivery_assignments.
--   * MANUAL_REQUIRED  — auto-assignment skipped because the shop coordinates
--                        are missing/invalid; HQ must assign a rider by hand.
--                        Emits Socket.IO "order.auto_assignment_failed" per
--                        R25 AC#5.
--   * FAILED           — auto-assignment ran but found no eligible rider
--                        (all AVAILABLE riders are out of range / already
--                        on a non-terminal delivery).
--
-- Naming reconciliation: tasks.md task 1.2 lists three values
-- (AUTO_ASSIGNED, MANUAL_REQUIRED, PENDING). Design §3.2.2 — which is the
-- declared source of truth in the spec — lists four
-- (PENDING, ASSIGNED, MANUAL_REQUIRED, FAILED) and uses ASSIGNED rather
-- than AUTO_ASSIGNED. We follow design §3.2.2 verbatim. The ASSIGNED
-- value also stays consistent with delivery_assignments.status='ASSIGNED'
-- which the auto-assignment job already writes.
--
-- Adds one supporting partial index (per design §3.2.2):
--   * idx_orders_auto_assignment_manual — `(created_at DESC) WHERE
--                                          auto_assignment_status =
--                                          'MANUAL_REQUIRED'`. Powers the
--                                          HQ "needs manual assignment"
--                                          queue without bloating the
--                                          general orders index.
--
-- Idempotent: re-running this migration is a no-op. The CHECK constraint
-- is created inside a DO block guarded by a pg_constraint lookup so the
-- second run does not raise `duplicate_object`.
--
-- Requirements: R25.5
-- Design:       §3.2.2 of .kiro/specs/multi-vendor-system/design.md

ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_assignment_status VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_auto_assignment_status'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_auto_assignment_status
      CHECK (
        auto_assignment_status IS NULL
        OR auto_assignment_status IN ('PENDING','ASSIGNED','MANUAL_REQUIRED','FAILED')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_auto_assignment_manual
  ON orders (created_at DESC)
  WHERE auto_assignment_status = 'MANUAL_REQUIRED';
