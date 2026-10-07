-- 090_first_time_offer_scope_and_free_delivery.sql
--
-- Brings first_time_offers up to parity with coupons' scoping/free-delivery
-- features (088_coupon_free_delivery_toggle.sql, and the category/product
-- scope columns coupons already had before that):
--
-- 1. applicable_category_ids / applicable_product_ids — lets an admin
--    restrict a first-time offer to specific categories/bundles/products,
--    exactly like a scoped coupon. NULL (the default) means "whole order",
--    identical to today's unscoped behavior — fully additive.
--
-- 2. grants_free_delivery — an independent toggle so a FLAT_DISCOUNT /
--    PERCENTAGE_DISCOUNT / WALLET_CASHBACK first-time offer can ALSO waive
--    delivery, instead of being forced to choose FREE_DELIVERY as the sole
--    reward_type. Mirrors coupons.grants_free_delivery exactly.
--
-- Fully additive: new nullable/defaulted columns only, no impact on
-- existing first-time offers or the checkout flow for unscoped ones.

ALTER TABLE first_time_offers
  ADD COLUMN IF NOT EXISTS applicable_category_ids UUID[],
  ADD COLUMN IF NOT EXISTS applicable_product_ids UUID[],
  ADD COLUMN IF NOT EXISTS grants_free_delivery BOOLEAN NOT NULL DEFAULT false;
