-- 023_theme_tabs_management.sql
-- Store-based theme tabs and merchandising source of truth

CREATE TABLE IF NOT EXISTS theme_tabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_key VARCHAR(50) NOT NULL,
  key VARCHAR(50) NOT NULL,
  label VARCHAR(100) NOT NULL,
  image_url TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  merch_config JSONB NOT NULL DEFAULT '{
    "seasonal_mosaic": { "category_ids": [], "product_ids": [], "limit": 8 },
    "featured": { "category_ids": [], "product_ids": [], "limit": 12 },
    "deals": { "category_ids": [], "product_ids": [], "limit": 12 },
    "trending": { "category_ids": [], "product_ids": [], "limit": 6 },
    "category_rails": []
  }'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'theme_tabs_store_key_check'
  ) THEN
    ALTER TABLE theme_tabs
      ADD CONSTRAINT theme_tabs_store_key_check
      CHECK (store_key IN ('zepto', 'off_zone', 'super_mall', 'cafe'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'theme_tabs_status_check'
  ) THEN
    ALTER TABLE theme_tabs
      ADD CONSTRAINT theme_tabs_status_check
      CHECK (status IN ('active', 'archived'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_tabs_store_key_key
  ON theme_tabs(store_key, key);
CREATE INDEX IF NOT EXISTS idx_theme_tabs_store_key_status_order
  ON theme_tabs(store_key, status, sort_order ASC);

ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS tab_id UUID REFERENCES theme_tabs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_app_themes_tab_id ON app_themes(tab_id);
CREATE INDEX IF NOT EXISTS idx_app_themes_tab_status_variant
  ON app_themes(tab_id, status, ab_variant);

ALTER TABLE theme_analytics ADD COLUMN IF NOT EXISTS store_key VARCHAR(50);
ALTER TABLE theme_analytics ADD COLUMN IF NOT EXISTS section_key VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_analytics_store_tab_created
  ON theme_analytics(store_key, tab_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_section_created
  ON theme_analytics(section_key, created_at DESC);

WITH source_tabs AS (
  SELECT DISTINCT ON (t.tab_key)
    t.tab_key,
    COALESCE(NULLIF(t.tab_label, ''), INITCAP(t.tab_key)) AS tab_label,
    NULLIF(t.tab_icon_url, '') AS tab_icon_url,
    COALESCE(t.tab_order, 0) AS tab_order
  FROM app_themes t
  WHERE t.tab_key IS NOT NULL
  ORDER BY t.tab_key, (t.status = 'active') DESC, t.updated_at DESC, t.created_at DESC
)
INSERT INTO theme_tabs (
  store_key,
  key,
  label,
  image_url,
  sort_order,
  status
)
SELECT
  'zepto',
  source_tabs.tab_key,
  source_tabs.tab_label,
  source_tabs.tab_icon_url,
  source_tabs.tab_order,
  'active'
FROM source_tabs
WHERE NOT EXISTS (
  SELECT 1
  FROM theme_tabs existing
  WHERE existing.store_key = 'zepto'
    AND existing.key = source_tabs.tab_key
);

UPDATE app_themes theme
SET tab_id = tab.id
FROM theme_tabs tab
WHERE theme.tab_key IS NOT NULL
  AND tab.store_key = 'zepto'
  AND tab.key = theme.tab_key
  AND theme.tab_id IS NULL;

UPDATE theme_analytics
SET store_key = 'zepto'
WHERE store_key IS NULL
  AND tab_key IS NOT NULL;

UPDATE theme_tabs tab
SET merch_config = jsonb_build_object(
  'seasonal_mosaic',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'dairy-eggs')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    8
  ),
  'featured',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'dairy-eggs')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'deals',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'dairy-eggs')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'trending',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'dairy-eggs')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    6
  ),
  'category_rails',
  COALESCE((
    SELECT jsonb_agg(rail)
    FROM (
      SELECT jsonb_build_object(
        'category_id',
        category.id,
        'product_ids',
        '[]'::jsonb,
        'limit',
        6,
        'title',
        CASE
          WHEN category.slug = 'fruits-vegetables' THEN 'Fresh Produce'
          WHEN category.slug = 'dairy-eggs' THEN 'Dairy & Eggs'
          ELSE NULL
        END
      ) AS rail
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'dairy-eggs')
      ORDER BY category.sort_order ASC, category.name ASC
    ) rails
  ), '[]'::jsonb)
)
WHERE tab.store_key = 'zepto'
  AND tab.key = 'fresh';

UPDATE theme_tabs tab
SET merch_config = jsonb_build_object(
  'seasonal_mosaic',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'rice-grains', 'dairy-eggs')
    ), '[]'::jsonb),
    'product_ids',
    COALESCE((
      SELECT jsonb_agg(product.id ORDER BY product.name)
      FROM products product
      WHERE product.slug IN (
        'banana-robusta',
        'apple-shimla',
        'potato',
        'spinach-palak',
        'amul-toned-milk-500ml',
        'india-gate-basmati-5kg'
      )
    ), '[]'::jsonb),
    'limit',
    8
  ),
  'featured',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'rice-grains')
    ), '[]'::jsonb),
    'product_ids',
    COALESCE((
      SELECT jsonb_agg(product.id ORDER BY product.name)
      FROM products product
      WHERE product.slug IN ('banana-robusta', 'apple-shimla', 'india-gate-basmati-5kg')
    ), '[]'::jsonb),
    'limit',
    12
  ),
  'deals',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'dairy-eggs')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'trending',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'rice-grains')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    6
  ),
  'category_rails',
  COALESCE((
    SELECT jsonb_agg(rail)
    FROM (
      SELECT jsonb_build_object(
        'category_id',
        category.id,
        'product_ids',
        '[]'::jsonb,
        'limit',
        6,
        'title',
        CASE
          WHEN category.slug = 'fruits-vegetables' THEN 'Vrat Essentials'
          WHEN category.slug = 'rice-grains' THEN 'Puja Staples'
          WHEN category.slug = 'dairy-eggs' THEN 'Dairy Picks'
          ELSE NULL
        END
      ) AS rail
      FROM categories category
      WHERE category.slug IN ('fruits-vegetables', 'rice-grains', 'dairy-eggs')
      ORDER BY category.sort_order ASC, category.name ASC
    ) rails
  ), '[]'::jsonb)
)
WHERE tab.store_key = 'zepto'
  AND tab.key = 'navratri';

UPDATE theme_tabs tab
SET merch_config = jsonb_build_object(
  'seasonal_mosaic',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('personal-care', 'household', 'beverages')
    ), '[]'::jsonb),
    'product_ids',
    COALESCE((
      SELECT jsonb_agg(product.id ORDER BY product.name)
      FROM products product
      WHERE product.slug IN (
        'dove-soap-100g',
        'head-shoulders-340ml',
        'nescafe-classic-100g',
        'real-mango-juice-1l'
      )
    ), '[]'::jsonb),
    'limit',
    8
  ),
  'featured',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('personal-care', 'household')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'deals',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('beverages', 'personal-care')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'trending',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('personal-care', 'household')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    6
  ),
  'category_rails',
  COALESCE((
    SELECT jsonb_agg(rail)
    FROM (
      SELECT jsonb_build_object(
        'category_id',
        category.id,
        'product_ids',
        '[]'::jsonb,
        'limit',
        6,
        'title',
        CASE
          WHEN category.slug = 'personal-care' THEN 'Beauty Picks'
          WHEN category.slug = 'household' THEN 'Home Style'
          WHEN category.slug = 'beverages' THEN 'Signature Scents'
          ELSE NULL
        END
      ) AS rail
      FROM categories category
      WHERE category.slug IN ('personal-care', 'household', 'beverages')
      ORDER BY category.sort_order ASC, category.name ASC
    ) rails
  ), '[]'::jsonb)
)
WHERE tab.store_key = 'zepto'
  AND tab.key = 'fashion';

UPDATE theme_tabs tab
SET merch_config = jsonb_build_object(
  'seasonal_mosaic',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('beverages', 'snacks-chips', 'household')
    ), '[]'::jsonb),
    'product_ids',
    COALESCE((
      SELECT jsonb_agg(product.id ORDER BY product.name)
      FROM products product
      WHERE product.slug IN (
        'coca-cola-750ml',
        'nescafe-classic-100g',
        'lays-classic-90g',
        'surf-excel-1-5kg'
      )
    ), '[]'::jsonb),
    'limit',
    8
  ),
  'featured',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('beverages', 'household')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'deals',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('snacks-chips', 'beverages')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    12
  ),
  'trending',
  jsonb_build_object(
    'category_ids',
    COALESCE((
      SELECT jsonb_agg(category.id ORDER BY category.name)
      FROM categories category
      WHERE category.slug IN ('beverages', 'snacks-chips', 'household')
    ), '[]'::jsonb),
    'product_ids',
    '[]'::jsonb,
    'limit',
    6
  ),
  'category_rails',
  COALESCE((
    SELECT jsonb_agg(rail)
    FROM (
      SELECT jsonb_build_object(
        'category_id',
        category.id,
        'product_ids',
        '[]'::jsonb,
        'limit',
        6,
        'title',
        CASE
          WHEN category.slug = 'beverages' THEN 'Power Drinks'
          WHEN category.slug = 'snacks-chips' THEN 'Snack Gadgets'
          WHEN category.slug = 'household' THEN 'Charging Accs'
          ELSE NULL
        END
      ) AS rail
      FROM categories category
      WHERE category.slug IN ('beverages', 'snacks-chips', 'household')
      ORDER BY category.sort_order ASC, category.name ASC
    ) rails
  ), '[]'::jsonb)
)
WHERE tab.store_key = 'zepto'
  AND tab.key = 'electronics';
