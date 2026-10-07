-- 161_marketplace_search_and_theme_keys.sql
-- Location-first discovery support + marketplace theme keys.

-- Theme tabs: the store_key CHECK still carries grocery brand keys
-- ('zepto','off_zone','super_mall','cafe'). Widen it for the marketplace.
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'theme_tabs'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%store_key%'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE theme_tabs DROP CONSTRAINT %I', c);
    EXECUTE format('ALTER TABLE theme_tabs ADD CONSTRAINT %I CHECK (store_key IN (''marketplace'', ''zepto'', ''off_zone'', ''super_mall'', ''cafe''))', c);
  END IF;
END $$;

INSERT INTO theme_tabs (store_key, key, label, sort_order, status)
VALUES ('marketplace', 'home', 'Home', 0, 'active')
ON CONFLICT DO NOTHING;

-- Ranking inputs on the product (popularity) and listing (delivery promise).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS popularity_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0
    CHECK (rating_avg >= 0 AND rating_avg <= 5),
  ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_products_popularity ON products(popularity_score DESC) WHERE deleted_at IS NULL;

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS sold_count INTEGER NOT NULL DEFAULT 0;

-- Serviceability lookups: pincode + distance ranking on active shops
CREATE INDEX IF NOT EXISTS idx_shops_service_pincodes_gin
  ON shops USING GIN (serviceable_pincodes)
  WHERE deleted_at IS NULL AND is_active = TRUE;

COMMENT ON COLUMN products.popularity_score IS 'Business ranking signal (sales velocity, views). Boost only — text relevance and serviceability still dominate ranking.';
