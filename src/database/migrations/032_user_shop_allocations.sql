-- 032_user_shop_allocations.sql
-- Create user_shop_allocations table for multi-vendor user-to-shop matching
-- Stores precomputed allocations between Customers and Shops based on
-- pincode match and/or haversine distance against the Shop's delivery radius.
-- One row per (user_id, shop_id); `is_primary` flags the closest Shop.

-- ═══════════════════════════════════════════════════════════════
-- 1. USER_SHOP_ALLOCATIONS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_shop_allocations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Match metadata
  distance_km           DECIMAL(5,2) NULL
                        CONSTRAINT chk_user_shop_allocations_distance_km
                          CHECK (distance_km IS NULL OR (distance_km >= 0.00 AND distance_km <= 999.99)),
  matched_pincode       VARCHAR(10) NULL,

  -- Primary (closest) shop flag
  is_primary            BOOLEAN NOT NULL DEFAULT false,

  -- Timestamps
  allocated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT uq_user_shop_allocations_user_shop UNIQUE (user_id, shop_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Customer lookup ordered with primary shop first.
-- Supports "fetch a user's allocations, primary shop ranked first"
-- queries used by product listing and primary-shop resolution.
CREATE INDEX IF NOT EXISTS idx_user_shop_allocations_user_primary
  ON user_shop_allocations (user_id, is_primary DESC);

-- Shop lookup (find all customers allocated to a shop, e.g. for
-- recompute jobs when a shop's service area or radius changes).
CREATE INDEX IF NOT EXISTS idx_user_shop_allocations_shop_id
  ON user_shop_allocations (shop_id);
