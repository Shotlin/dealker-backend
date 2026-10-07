-- 033_widen_allocation_distance.sql
-- Widen user_shop_allocations.distance_km from DECIMAL(5,2) to DECIMAL(8,2).
--
-- ROOT CAUSE FIX: distance_km was DECIMAL(5,2) (max 999.99 km), but a shop
-- can serve a pincode that is geographically far from the customer (a
-- pincode-only match with no radius overlap). The allocation queries compute
-- haversine distance as numeric(7,2), so inserting a far pincode-matched shop
-- (e.g. 1648 km) overflowed the column with `numeric field overflow` (22003),
-- rolling back the ENTIRE allocation recompute transaction. The customer's
-- allocation therefore silently failed to include such shops — making their
-- products appear in listings yet fail cart validation ("not available at
-- your location").
--
-- DECIMAL(8,2) (max 999999.99 km) comfortably covers any earth-surface
-- distance (max ~20,000 km). Idempotent + non-destructive.

DO $$
BEGIN
  -- Drop the old <= 999.99 check constraint if present.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_user_shop_allocations_distance_km'
  ) THEN
    ALTER TABLE user_shop_allocations
      DROP CONSTRAINT chk_user_shop_allocations_distance_km;
  END IF;

  -- Widen the column type (safe: only increases precision).
  ALTER TABLE user_shop_allocations
    ALTER COLUMN distance_km TYPE DECIMAL(8,2);

  -- Re-add a non-negative check with the widened upper bound.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_user_shop_allocations_distance_km'
  ) THEN
    ALTER TABLE user_shop_allocations
      ADD CONSTRAINT chk_user_shop_allocations_distance_km
      CHECK (distance_km IS NULL OR (distance_km >= 0.00 AND distance_km <= 999999.99));
  END IF;
END $$;
