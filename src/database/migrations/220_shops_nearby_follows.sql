-- Home "Shops (Nearby N)" section: customers can follow shops, and the section
-- becomes a placeable theme-builder section type.
CREATE TABLE IF NOT EXISTS shop_follows (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id    UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, shop_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_follows_shop ON shop_follows (shop_id);

ALTER TABLE section_manifests
  DROP CONSTRAINT IF EXISTS section_manifests_section_type_check;

ALTER TABLE section_manifests
  ADD CONSTRAINT section_manifests_section_type_check
    CHECK (section_type IN (
      'animated_banner',
      'fee_strip',
      'seasonal_mosaic',
      'round_category_icons',
      'category_product_grid',
      'product_carousel',
      'trending_products',
      'promo_carousel',
      'bank_offers',
      'custom_banner',
      'text_header',
      'arched_product_showcase',
      'spacer',
      'live_auction',
      'deal_of_day',
      'recent_recommended',
      'steal_deals',
      'collection_showcase',
      'brand_spotlight',
      'price_shop',
      'category_hub',
      'banner_rail',
      'top_brands',
      'price_sale',
      'oval_spotlight',
      'category_deals',
      'shops_nearby'
    ));
