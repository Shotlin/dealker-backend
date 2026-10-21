-- Home section: Category Deals (category picture tiles with that category's products). Earlier types are kept.
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
      'category_deals'
    ));
