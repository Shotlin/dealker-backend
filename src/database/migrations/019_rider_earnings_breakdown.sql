-- 019_rider_earnings_breakdown.sql
-- Persist rider payout breakdown components and make per-order earnings authoritative.

ALTER TABLE rider_earnings
  ADD COLUMN IF NOT EXISTS base_fee DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS distance_bonus DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS performance_bonus DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_amount DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE rider_earnings
SET
  base_fee = COALESCE(NULLIF(base_fee, 0), amount),
  distance_bonus = COALESCE(distance_bonus, 0),
  performance_bonus = COALESCE(performance_bonus, 0),
  tip_amount = COALESCE(tip_amount, 0),
  updated_at = COALESCE(updated_at, created_at, NOW())
WHERE
  base_fee IS NULL
  OR distance_bonus IS NULL
  OR performance_bonus IS NULL
  OR tip_amount IS NULL
  OR updated_at IS NULL
  OR (COALESCE(base_fee, 0) = 0 AND COALESCE(amount, 0) > 0);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY order_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM rider_earnings
  WHERE order_id IS NOT NULL
)
DELETE FROM rider_earnings
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rider_earnings_order_unique
  ON rider_earnings(order_id)
  WHERE order_id IS NOT NULL;
