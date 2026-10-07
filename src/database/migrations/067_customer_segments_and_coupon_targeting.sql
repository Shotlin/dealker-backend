-- 067_customer_segments_and_coupon_targeting.sql
--
-- Phase 1 of the customer-segment marketing system:
--
-- 1. customer_segments / customer_segment_members: admin-defined groups of
--    customers, manually curated (e.g. "VIP Grocery Customers"). A user can
--    belong to multiple segments (no uniqueness beyond one row per
--    segment+user pair).
--
-- 2. Coupon targeting: coupons.target_type decides who may redeem a coupon
--    (ALL / SEGMENT / INDIVIDUAL / FIRST_TIME). SEGMENT targeting points at
--    a single customer_segments row; INDIVIDUAL targeting uses the new
--    coupon_target_users join table (a coupon can list many specific
--    customers). Defaults to 'ALL' so every existing coupon keeps working
--    exactly as before — fully backward compatible, no backfill needed.
--
-- Fully additive: safe defaults, new tables/columns only, no impact on
-- existing coupons/orders/notifications.

CREATE TABLE IF NOT EXISTS customer_segments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_segment_members (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  segment_id UUID NOT NULL REFERENCES customer_segments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES users(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(segment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_segment_members_user ON customer_segment_members(user_id);
CREATE INDEX IF NOT EXISTS idx_segment_members_segment ON customer_segment_members(segment_id);

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) NOT NULL DEFAULT 'ALL',
  ADD COLUMN IF NOT EXISTS target_segment_id UUID REFERENCES customer_segments(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_target_type'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_target_type
      CHECK (target_type IN ('ALL', 'SEGMENT', 'INDIVIDUAL', 'FIRST_TIME'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS coupon_target_users (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(coupon_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_coupon_target_users_coupon ON coupon_target_users(coupon_id);
