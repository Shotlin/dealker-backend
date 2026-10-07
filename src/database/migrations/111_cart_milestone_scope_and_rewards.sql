-- Migration 111: Cart Milestones parity with coupons/first_time_offers
--
-- Consolidates 4 additive bakaloo migrations into one for meet-commerce
-- (numbers 100-107 are already taken here by unrelated migrations):
--   100_cart_milestone_free_delivery_toggle.sql — grants_free_delivery
--   101_cart_milestone_reward_percent.sql        — reward_percent
--   103_cart_milestone_scope.sql                 — applicable_category_ids / applicable_product_ids
--   106_cart_milestone_excluded_segment.sql      — excluded_segment_id
--   107_cart_milestone_exclude_first_time.sql    — exclude_first_time_users
--
-- All columns are nullable/defaulted and fully additive — no impact on
-- existing cart milestones or the checkout flow for unscoped ones.

ALTER TABLE cart_milestones
  ADD COLUMN IF NOT EXISTS reward_percent DECIMAL(5,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS grants_free_delivery BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS applicable_category_ids UUID[],
  ADD COLUMN IF NOT EXISTS applicable_product_ids UUID[],
  ADD COLUMN IF NOT EXISTS excluded_segment_id UUID REFERENCES customer_segments(id),
  ADD COLUMN IF NOT EXISTS exclude_first_time_users BOOLEAN NOT NULL DEFAULT false;
