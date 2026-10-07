-- 070_cart_milestones.sql
--
-- Phase 3 of the customer-segment marketing system: cart milestones — a
-- graduated ladder of rewards unlocked purely by cart value (unlike
-- first_time_offers, applies to every eligible order, not just a
-- customer's first one). Free delivery is intentionally NOT a milestone
-- reward type here — the existing single fee_settings.free_delivery_above
-- threshold stays the one source of truth for that, so admins never see
-- two different "free delivery unlocks at ₹X" settings.
--
-- message_before is a template with a literal `{amount}` placeholder the
-- backend substitutes with the live "add ₹X more" figure (e.g.
-- "Add ₹{amount} more to unlock free delivery" → "Add ₹60 more to unlock
-- free delivery"); message_after is shown once unlocked.
--
-- Fully additive: new table only, no impact on existing cart/order/coupon
-- flows until an admin creates a milestone.

CREATE TABLE IF NOT EXISTS cart_milestones (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                     VARCHAR(100) NOT NULL,
  min_cart_amount          DECIMAL(10,2) NOT NULL,
  reward_type              VARCHAR(20) NOT NULL,
  reward_value             DECIMAL(10,2),
  max_discount             DECIMAL(10,2),
  unlock_coupon_id         UUID REFERENCES coupons(id),
  message_before           TEXT,
  message_after            TEXT,
  icon_url                 TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  applicable_user_type     VARCHAR(20) NOT NULL DEFAULT 'ALL',
  applicable_segment_id    UUID REFERENCES customer_segments(id),
  stackable_with_coupon    BOOLEAN NOT NULL DEFAULT true,
  priority                 INTEGER NOT NULL DEFAULT 0,
  cashback_credit_trigger  VARCHAR(20) NOT NULL DEFAULT 'ORDER_DELIVERED',
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cart_milestones_reward_type CHECK (
    reward_type IN ('CASHBACK', 'FLAT_DISCOUNT', 'COUPON_UNLOCK')
  ),
  CONSTRAINT chk_cart_milestones_user_type CHECK (
    applicable_user_type IN ('ALL', 'FIRST_TIME', 'SEGMENT')
  ),
  CONSTRAINT chk_cart_milestones_credit_trigger CHECK (
    cashback_credit_trigger IN ('PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED')
  )
);

CREATE INDEX IF NOT EXISTS idx_cart_milestones_active
  ON cart_milestones(is_active, min_cart_amount);
