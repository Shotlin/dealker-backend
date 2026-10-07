-- 069_coupon_cashback_and_free_delivery.sql
--
-- Phase 2 follow-through: the dashboard's Coupon type has declared
-- discountType: "CASHBACK" | "FREE_DELIVERY" since before this session
-- (alongside PERCENTAGE/FLAT/BOGO), but the backend `discount_type` enum
-- (007_coupons.sql) only ever supported PERCENTAGE/FLAT — selecting
-- CASHBACK/FREE_DELIVERY in the dashboard would fail or silently
-- misbehave. This migration adds the two enum values and a
-- cashback_credit_trigger column (mirrors first_time_offers — admin
-- controls whether a CASHBACK coupon credits after payment, order
-- confirmation, or delivery).
--
-- BOGO is intentionally left unsupported — it was never part of this
-- feature request and has no wiring anywhere (bogoProductId is declared
-- but unused in both the dashboard form and the backend), so extending it
-- is out of scope here.
--
-- Fully additive: ALTER TYPE ADD VALUE + a new column with a safe default.
-- Existing PERCENTAGE/FLAT coupons are completely unaffected.

ALTER TYPE discount_type ADD VALUE IF NOT EXISTS 'CASHBACK';
ALTER TYPE discount_type ADD VALUE IF NOT EXISTS 'FREE_DELIVERY';

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS cashback_credit_trigger VARCHAR(20) NOT NULL DEFAULT 'ORDER_DELIVERED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_coupons_cashback_trigger'
  ) THEN
    ALTER TABLE coupons
      ADD CONSTRAINT chk_coupons_cashback_trigger
      CHECK (cashback_credit_trigger IN ('PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'));
  END IF;
END $$;
