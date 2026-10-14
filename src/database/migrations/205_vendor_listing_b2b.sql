-- 205_vendor_listing_b2b.sql
-- Vendor app "Add Product" flow: one listing can be sold to customers (B2C), to other
-- vendors in bulk (B2B), or both. sell_b2c / sell_b2b (179), wholesale_price (118),
-- min_order_qty (154) and products.video_url (154) already exist — this adds the few
-- remaining B2B terms and the seller's own pre-check. Additive and idempotent.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS b2b_discount_pct NUMERIC(5,2)
    CHECK (b2b_discount_pct IS NULL OR (b2b_discount_pct >= 0 AND b2b_discount_pct <= 50)),
  ADD COLUMN IF NOT EXISTS b2b_notes TEXT,
  -- Seller's own checklist (physical checks, photo angles, video checks). Informational: the
  -- platform decision is still qc_status, set by the QC rules / an admin.
  ADD COLUMN IF NOT EXISTS vendor_qc JSONB;
