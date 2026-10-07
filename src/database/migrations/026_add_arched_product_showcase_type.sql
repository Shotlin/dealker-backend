-- 026_add_arched_product_showcase_type.sql
-- Adds arched_product_showcase to the allowed section_type values

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
      'spacer'
    ));
