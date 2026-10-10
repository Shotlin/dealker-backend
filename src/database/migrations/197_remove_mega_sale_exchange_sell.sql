-- Mega Sale strip and Exchange & Sell sections were removed from the product
-- (a plain banner covers both). Delete any placed rows, then tighten the CHECK.
DELETE FROM section_manifests
 WHERE section_type IN ('mega_sale', 'exchange_sell');

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
      'recent_recommended'
    ));
