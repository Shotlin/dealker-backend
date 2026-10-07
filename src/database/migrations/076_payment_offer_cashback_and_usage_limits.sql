-- Migration 076: Wire Payment Offers into real checkout cashback (they were
-- previously a cart-page marketing banner only — computed a lock/unlock
-- display flag but never credited anything), and add a per-user usage cap
-- to both Payment Offers and Cart Milestones so an admin can limit a
-- customer to redeeming the same reward N times (or unlimited, the
-- existing/default behavior, if left unset).

-- 1. Let cashback_transactions accept a PAYMENT_OFFER source.
ALTER TABLE cashback_transactions DROP CONSTRAINT IF EXISTS chk_cashback_tx_source_type;
ALTER TABLE cashback_transactions ADD CONSTRAINT chk_cashback_tx_source_type CHECK (
  source_type IN ('COUPON', 'FIRST_TIME_OFFER', 'CART_MILESTONE', 'PAYMENT_OFFER')
);

-- 2. payment_offers needs a credit-trigger (mirrors first_time_offers /
--    cart_milestones — it never had one because nothing ever consumed it)
--    and a per-user usage cap.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_offers' AND column_name = 'cashback_credit_trigger'
  ) THEN
    ALTER TABLE payment_offers ADD COLUMN cashback_credit_trigger VARCHAR(20) NOT NULL DEFAULT 'ORDER_DELIVERED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_offers_credit_trigger'
  ) THEN
    ALTER TABLE payment_offers ADD CONSTRAINT chk_payment_offers_credit_trigger CHECK (
      cashback_credit_trigger IN ('PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED')
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_offers' AND column_name = 'usage_limit_per_user'
  ) THEN
    ALTER TABLE payment_offers ADD COLUMN usage_limit_per_user INTEGER;
  END IF;
END $$;

-- 3. cart_milestones per-user usage cap (same NULL = unlimited convention).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cart_milestones' AND column_name = 'usage_limit_per_user'
  ) THEN
    ALTER TABLE cart_milestones ADD COLUMN usage_limit_per_user INTEGER;
  END IF;
END $$;

-- 4. Usage-tracking tables — same minimal shape as the existing
--    coupon_usages table (migration 007_coupons.sql).
CREATE TABLE IF NOT EXISTS payment_offer_usages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_offer_id  UUID REFERENCES payment_offers(id) NOT NULL,
  user_id           UUID REFERENCES users(id) NOT NULL,
  order_id          UUID REFERENCES orders(id),
  used_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_offer_usage_offer ON payment_offer_usages(payment_offer_id);
CREATE INDEX IF NOT EXISTS idx_payment_offer_usage_user ON payment_offer_usages(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_offer_usage_unique ON payment_offer_usages(payment_offer_id, user_id, order_id);

CREATE TABLE IF NOT EXISTS cart_milestone_usages (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cart_milestone_id  UUID REFERENCES cart_milestones(id) NOT NULL,
  user_id            UUID REFERENCES users(id) NOT NULL,
  order_id           UUID REFERENCES orders(id),
  used_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cart_milestone_usage_milestone ON cart_milestone_usages(cart_milestone_id);
CREATE INDEX IF NOT EXISTS idx_cart_milestone_usage_user ON cart_milestone_usages(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_milestone_usage_unique ON cart_milestone_usages(cart_milestone_id, user_id, order_id);
