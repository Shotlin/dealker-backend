-- 007_coupons.sql
-- Discount coupons

CREATE TYPE discount_type AS ENUM ('PERCENTAGE', 'FLAT');

CREATE TABLE IF NOT EXISTS coupons (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code              VARCHAR(50) UNIQUE NOT NULL,
  description       TEXT,
  discount_type     discount_type NOT NULL,
  discount_value    DECIMAL(10,2) NOT NULL CHECK (discount_value > 0),
  min_order_amount  DECIMAL(10,2) DEFAULT 0,
  max_discount      DECIMAL(10,2),
  usage_limit       INTEGER,
  used_count        INTEGER DEFAULT 0,
  per_user_limit    INTEGER DEFAULT 1,
  valid_from        TIMESTAMPTZ,
  valid_until       TIMESTAMPTZ,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupons_code    ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_active  ON coupons(is_active, valid_until);

-- Track per-user coupon usage
CREATE TABLE IF NOT EXISTS coupon_usages (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  coupon_id  UUID REFERENCES coupons(id) NOT NULL,
  user_id    UUID REFERENCES users(id) NOT NULL,
  order_id   UUID REFERENCES orders(id),
  used_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupon_usage_coupon ON coupon_usages(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_usage_user   ON coupon_usages(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_usage_unique ON coupon_usages(coupon_id, user_id, order_id);
