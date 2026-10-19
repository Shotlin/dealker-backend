-- 211_auction_views.sql
-- Auction cards show how many people have looked at the lot (eye count) — bumped when a bidder opens
-- the detail page. Additive and idempotent.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
