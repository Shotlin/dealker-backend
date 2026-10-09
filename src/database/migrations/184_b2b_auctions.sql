-- 184_b2b_auctions.sql
-- B2B (vendor-to-vendor, lot) auctions beside the existing B2C (customer)
-- auctions. A B2B auction sells `quantity` units as ONE lot: bids and the
-- winning price are for the whole lot (per-unit price = lot ÷ quantity), only
-- verified vendors (optionally an invited list) may bid, and the resulting
-- order is a B2B order priced with the B2B commission rules.
-- Orders also get an explicit channel so B2C / B2B order lists stay separate.

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'B2C' CHECK (audience IN ('B2C', 'B2B')),
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  ADD COLUMN IF NOT EXISTS eligible_vendor_ids UUID[];

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_b2c_single_unit;
ALTER TABLE auctions ADD CONSTRAINT auctions_b2c_single_unit CHECK (audience = 'B2B' OR quantity = 1);
CREATE INDEX IF NOT EXISTS idx_auctions_audience_status ON auctions (audience, status);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_channel TEXT NOT NULL DEFAULT 'B2C' CHECK (order_channel IN ('B2C', 'B2B'));
CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders (order_channel, created_at DESC);
