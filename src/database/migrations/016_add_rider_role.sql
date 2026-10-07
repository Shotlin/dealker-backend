-- 016_add_rider_role.sql
-- Fix: The rider app sends role='RIDER' but the enum only has 'DELIVERY'.
-- We need BOTH to work: existing DELIVERY riders AND the rider app sending 'RIDER'.
-- Solution: Add 'RIDER' to the enum and treat it the same as 'DELIVERY' in queries.

-- Add RIDER to the user_role enum (safe — IF NOT EXISTS not supported for enum values)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'user_role'::regtype AND enumlabel = 'RIDER'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'RIDER';
  END IF;
END $$;

-- Update any existing riders who were seeded as 'DELIVERY' to 'RIDER' for consistency
-- (This ensures the admin query using IN ('RIDER', 'DELIVERY') catches all riders)
