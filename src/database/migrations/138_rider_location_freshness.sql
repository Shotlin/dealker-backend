-- 138_rider_location_freshness.sql
-- Dispatch eligibility (blueprint Big Phase 6): a rider is offered an
-- order only while their last known GPS fix is fresh. `updated_at` is
-- also bumped by toggle-online, so it cannot serve as a location
-- timestamp — this adds a dedicated one.
--
-- Backfill: seed existing riders with their last profile update so a
-- deploy does not suddenly mark every rider stale. Rows older than the
-- dispatch staleness window simply stay stale, as they already were.

ALTER TABLE rider_profiles
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

UPDATE rider_profiles
   SET location_updated_at = updated_at
 WHERE location_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rider_location_fresh
  ON rider_profiles (location_updated_at)
 WHERE is_online = true;
