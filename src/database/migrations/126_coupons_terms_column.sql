-- 126_coupons_terms_column.sql
--
-- The mobile app's coupon UI (and the admin coupon response schema,
-- coupons.schema.js's `couponProperties.terms`) have expected a
-- customer-facing `terms` string on every coupon for a while, but no such
-- column has ever existed on `coupons` — `coupons.repository.js#_format`
-- never set it, so `coupons.service.js`'s `coupon.terms ?? null` was
-- always `null` in practice. Every coupon's expandable "T&C" section had
-- nothing real to show.
--
-- Purely additive: one nullable TEXT column, no backfill, no constraint.
-- coupons.repository.js (COUPON_COLUMNS, create(), update(), _format())
-- now reads/writes it.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS terms TEXT;
