-- 025_seed_section_manifests.sql
-- Seed default section manifests for the current zepto tabs
-- Note: migrate.js already wraps each migration file in a transaction.

INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config)
SELECT tt.id, vals.section_type, vals.sort_order, true, vals.config::jsonb
FROM theme_tabs tt
CROSS JOIN (
  VALUES
    ('animated_banner', 0, '{"gradient":["#E8F5E9","#C8E6C9"],"container_color":"#E8F5E9","height":220,"layout_variant":"full_bleed"}'),
    ('fee_strip', 1, '{"image_url":null,"visible":true,"pill_style":"soft","accent_color":"#14B86A"}'),
    ('seasonal_mosaic', 2, '{"layout_variant":"hero_plus_four","container_color":"#FFF8E1","hero_ratio":"16:10","tile_radius":16}'),
    ('round_category_icons', 3, '{"icon_size":64,"gap":12,"show_labels":true,"columns":4}'),
    ('category_product_grid', 4, '{"title":"Best Sellers","columns":3,"card_shape":"rounded","image_ratio":"1:1","show_quick_add":true}'),
    ('trending_products', 5, '{"title":"Trending Near You","limit":6,"card_style":"compact","accent_color":"#FF6B35"}')
) AS vals(section_type, sort_order, config)
WHERE tt.store_key = 'zepto'
  AND tt.key = 'all'
  AND NOT EXISTS (
    SELECT 1
    FROM section_manifests existing
    WHERE existing.tab_id = tt.id
      AND existing.section_type = vals.section_type
      AND existing.sort_order = vals.sort_order
  )
ON CONFLICT DO NOTHING;

INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config)
SELECT tt.id, vals.section_type, vals.sort_order, true, vals.config::jsonb
FROM theme_tabs tt
CROSS JOIN (
  VALUES
    ('animated_banner', 0, '{"gradient":["#FFF3E0","#FEEBCC"],"container_color":"#FFF8ED","height":220,"layout_variant":"festival_hero"}'),
    ('seasonal_mosaic', 1, '{"layout_variant":"hero_plus_four","container_color":"#FFF8ED","hero_ratio":"4:3","tile_radius":16}'),
    ('category_product_grid', 2, '{"title":"Navratri Specials","columns":3,"card_shape":"rounded","image_ratio":"1:1","show_quick_add":true}'),
    ('trending_products', 3, '{"title":"Festive Favorites","limit":6,"card_style":"compact","accent_color":"#FF8C00"}')
) AS vals(section_type, sort_order, config)
WHERE tt.store_key = 'zepto'
  AND tt.key = 'navratri'
  AND NOT EXISTS (
    SELECT 1
    FROM section_manifests existing
    WHERE existing.tab_id = tt.id
      AND existing.section_type = vals.section_type
      AND existing.sort_order = vals.sort_order
  )
ON CONFLICT DO NOTHING;

INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config)
SELECT tt.id, vals.section_type, vals.sort_order, true, vals.config::jsonb
FROM theme_tabs tt
CROSS JOIN (
  VALUES
    ('animated_banner', 0, '{"gradient":["#E3F2FD","#BBDEFB"],"container_color":"#E8F5E9","height":220,"layout_variant":"fresh_highlight"}'),
    ('round_category_icons', 1, '{"icon_size":64,"gap":12,"show_labels":true,"columns":4}'),
    ('category_product_grid', 2, '{"title":"Fresh Picks","columns":3,"card_shape":"rounded","image_ratio":"1:1","show_quick_add":true}'),
    ('product_carousel', 3, '{"title":"Just Arrived","card_style":"standard","auto_scroll":false,"peek":24}')
) AS vals(section_type, sort_order, config)
WHERE tt.store_key = 'zepto'
  AND tt.key = 'fresh'
  AND NOT EXISTS (
    SELECT 1
    FROM section_manifests existing
    WHERE existing.tab_id = tt.id
      AND existing.section_type = vals.section_type
      AND existing.sort_order = vals.sort_order
  )
ON CONFLICT DO NOTHING;

INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config)
SELECT tt.id, vals.section_type, vals.sort_order, true, vals.config::jsonb
FROM theme_tabs tt
CROSS JOIN (
  VALUES
    ('animated_banner', 0, '{"gradient":["#FCE4EC","#F8BBD0"],"container_color":"#FFF0F5","height":220,"layout_variant":"editorial_hero"}'),
    ('round_category_icons', 1, '{"icon_size":64,"gap":12,"show_labels":true,"columns":4}'),
    ('promo_carousel', 2, '{"auto_scroll_speed":3000,"aspect_ratio":"16:9","border_radius":12,"show_pagination":true}'),
    ('product_carousel', 3, '{"title":"Fashion Picks","card_style":"standard","auto_scroll":false,"peek":24}')
) AS vals(section_type, sort_order, config)
WHERE tt.store_key = 'zepto'
  AND tt.key = 'fashion'
  AND NOT EXISTS (
    SELECT 1
    FROM section_manifests existing
    WHERE existing.tab_id = tt.id
      AND existing.section_type = vals.section_type
      AND existing.sort_order = vals.sort_order
  )
ON CONFLICT DO NOTHING;

INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config)
SELECT tt.id, vals.section_type, vals.sort_order, true, vals.config::jsonb
FROM theme_tabs tt
CROSS JOIN (
  VALUES
    ('animated_banner', 0, '{"gradient":["#212121","#424242"],"container_color":"#212121","height":220,"layout_variant":"dark_feature"}'),
    ('fee_strip', 1, '{"image_url":null,"visible":true,"pill_style":"solid","accent_color":"#FFB300"}'),
    ('seasonal_mosaic', 2, '{"layout_variant":"two_by_three","container_color":"#212121","hero_ratio":"16:10","tile_radius":16}'),
    ('category_product_grid', 3, '{"title":"Top Electronics","columns":3,"card_shape":"rounded","image_ratio":"1:1","show_quick_add":true}')
) AS vals(section_type, sort_order, config)
WHERE tt.store_key = 'zepto'
  AND tt.key = 'electronics'
  AND NOT EXISTS (
    SELECT 1
    FROM section_manifests existing
    WHERE existing.tab_id = tt.id
      AND existing.section_type = vals.section_type
      AND existing.sort_order = vals.sort_order
  )
ON CONFLICT DO NOTHING;
