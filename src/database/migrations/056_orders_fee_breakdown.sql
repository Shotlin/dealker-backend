-- 056_orders_fee_breakdown.sql
-- Persist the canonical fee breakdown snapshot on each order so a placed
-- order always keeps the exact fees it was charged, even after the global
-- fee_settings config changes later (Phase 7 — order/payment consistency).
--
-- The existing scalar columns (delivery_fee, platform_fee, handling_fee,
-- discount_amount, total_amount, savings_total) remain authoritative for
-- payment + reporting; this JSONB captures the full breakdown (small-cart /
-- surge / packaging fees, distance, free-delivery state, per-fee labels).
-- Idempotent.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN orders.fee_breakdown IS
  'Canonical TotalsEngine breakdown snapshot at order time (fees[], distance, freeDelivery, per-fee labels). Authoritative scalar totals stay in their own columns.';
