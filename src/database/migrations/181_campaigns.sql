-- 181_campaigns.sql
-- Promotional campaigns: scheduled discounts (flash sale, deal of the day,
-- clearance, vendor / product / discount campaigns) and coupon campaigns.
-- A campaign applies a price batch + section placement when it starts and
-- reverts both when it ends, and keeps the listings it touched so sales can
-- be attributed to it. Additive and idempotent.

-- Flash Sale joins the product sections.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'shop_products'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%merch_section%'
  LOOP
    EXECUTE format('ALTER TABLE shop_products DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_merch_section_check
  CHECK (merch_section IS NULL OR merch_section IN
    ('NEW_ARRIVAL', 'DEAL_OF_THE_DAY', 'CLEARANCE_SALE', 'FEATURED', 'BEST_SELLER', 'FLASH_SALE'));

CREATE TABLE IF NOT EXISTS promo_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('GENERAL', 'VENDOR', 'PRODUCT', 'DISCOUNT', 'FLASH_SALE', 'DEAL_OF_THE_DAY', 'CLEARANCE_SALE', 'COUPON')),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  discount JSONB,                         -- { operation, value, rounding?, allowBelowCost? }
  section TEXT CHECK (section IS NULL OR section IN ('NEW_ARRIVAL', 'DEAL_OF_THE_DAY', 'CLEARANCE_SALE', 'FEATURED', 'BEST_SELLER', 'FLASH_SALE')),
  coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
  activation_batch_id UUID REFERENCES price_adjustment_batches(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  listing_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT promo_campaigns_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_promo_campaigns_status ON promo_campaigns(status, starts_at);
CREATE INDEX IF NOT EXISTS idx_promo_campaigns_created ON promo_campaigns(created_at DESC);

CREATE TABLE IF NOT EXISTS promo_campaign_listings (
  campaign_id UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  shop_product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  price_before NUMERIC(12,2),
  price_after NUMERIC(12,2),
  previous_section TEXT,
  previous_section_ends TIMESTAMPTZ,
  previous_position INTEGER,
  PRIMARY KEY (campaign_id, shop_product_id)
);
CREATE INDEX IF NOT EXISTS idx_promo_campaign_listings_listing ON promo_campaign_listings(shop_product_id);

UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['campaigns.view','campaigns.manage'])))
   )
 WHERE name IN ('Platform Admin', 'Marketing Manager');
