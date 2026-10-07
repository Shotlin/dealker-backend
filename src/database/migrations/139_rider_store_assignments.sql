-- 139_rider_store_assignments.sql
-- Store scoping (blueprint Big Phase 6 / §5): the smallest safe mechanism
-- to mark a rider eligible for one or more FreshCuts stores. Dispatch
-- consults this table only when RIDER_STORE_SCOPING=true, so enabling
-- the migration is rollout-safe: existing unscoped dispatch keeps
-- working until ops opts in per environment.
--
-- rider_id mirrors the delivery_assignments convention: it holds
-- users.id (the rider's user id), not rider_profiles.id.

CREATE TABLE IF NOT EXISTS rider_store_assignments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per rider+shop pair; re-assigning reactivates the row
  -- (is_active flips back to true) instead of duplicating history.
  CONSTRAINT uq_rider_store_assignments UNIQUE (rider_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_rider_store_assignments_shop
  ON rider_store_assignments (shop_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_rider_store_assignments_rider
  ON rider_store_assignments (rider_id)
  WHERE is_active = true;
