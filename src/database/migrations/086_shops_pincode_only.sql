-- 086_shops_pincode_only.sql
--
-- Per-shop opt-in: when true, the shop is matchable ONLY via its exact
-- serviceable_pincodes list — delivery_radius_km is never used as a
-- fallback match for this shop. Off by default for every existing and
-- new shop, so this is a zero-behavior-change migration until an admin
-- explicitly turns it on for a specific shop.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS pincode_only BOOLEAN NOT NULL DEFAULT false;
