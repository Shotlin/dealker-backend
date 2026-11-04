-- 224_deal_entries.sql
-- Vendor entries for deals (promo campaigns). A deal can be opened to vendors: they put their
-- own listings in, an admin approves, and when the campaign starts the approved listings get
-- the campaign discount. Additive and idempotent.

ALTER TABLE promo_campaigns
  ADD COLUMN IF NOT EXISTS open_to_vendors BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS entry_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS min_vendor_tier TEXT NOT NULL DEFAULT 'FREE'
    CHECK (min_vendor_tier IN ('FREE', 'PAID', 'PREMIUM', 'UNLIMITED')),
  ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS max_entries_per_vendor INTEGER CHECK (max_entries_per_vendor IS NULL OR max_entries_per_vendor > 0);

CREATE TABLE IF NOT EXISTS deal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  shop_product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  price_at_entry NUMERIC(12,2),
  reject_reason TEXT,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, shop_product_id)
);
CREATE INDEX IF NOT EXISTS idx_deal_entries_campaign ON deal_entries(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_deal_entries_vendor ON deal_entries(vendor_id, created_at DESC);
