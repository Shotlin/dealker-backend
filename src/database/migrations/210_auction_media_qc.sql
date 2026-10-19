-- 210_auction_media_qc.sql
-- Auctions carry their own product video and seller QC report so bidders can see them before bidding.
--   video_url  quality-evidence video (same upload endpoint as the product video)
--   qc_report  { checks: {label: bool}, photos: [url], notes: text } — the seller's own pre-check,
--              informational (the platform QC decision stays on shop_products.qc_status).
-- Additive and idempotent. Existing auctions are backfilled from their product's video / vendor_qc.

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS qc_report JSONB;

UPDATE auctions a
   SET video_url = COALESCE(a.video_url, p.video_url)
  FROM products p
 WHERE p.id = a.product_id AND a.video_url IS NULL AND p.video_url IS NOT NULL;

UPDATE auctions a
   SET qc_report = sp.vendor_qc
  FROM shop_products sp
 WHERE sp.id = a.shop_product_id AND a.qc_report IS NULL AND sp.vendor_qc IS NOT NULL;
