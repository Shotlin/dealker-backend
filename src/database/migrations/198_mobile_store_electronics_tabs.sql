-- Mobile store tab strip for an electronics marketplace (same effect as seeds/mobile-store-tabs.js, but applied
-- automatically by the deploy's migrate step).
--   * ARCHIVES (never deletes) the grocery-era tabs ramadan, fashion, beauty, health, home.
--   * Keeps all / mobile / electronics, adds headphones + accessories (and creates mobile / electronics only if
--     missing).
--   * A tab with no sections of its own gets one product grid holding its real in-stock products (found by name).
-- Idempotent: safe to run on a database that was already cleaned by the seed script. The public tab list is
-- cached for 5 minutes, so the strip refreshes by itself shortly after the deploy.
DO $$
DECLARE
  store CONSTANT TEXT := 'mobile';
  spec RECORD;
  tab_row RECORD;
  ids JSONB;
  tmpl JSONB;
BEGIN
  -- 1. archive the unwanted tabs (reversible from the dashboard)
  UPDATE theme_tabs
     SET status = 'archived', archived_at = NOW(), is_default = FALSE, updated_at = NOW()
   WHERE store_key = store AND status = 'active'
     AND key IN ('ramadan', 'fashion', 'beauty', 'health', 'home');

  -- 2. make sure the five tabs exist, in order
  FOR spec IN
    SELECT * FROM (VALUES
      ('mobile', 'Mobile', 1), ('electronics', 'Electronics', 2),
      ('headphones', 'Headphones', 3), ('accessories', 'Accessories', 4)
    ) AS v(key, label, sort_order)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM theme_tabs WHERE store_key = store AND key = spec.key AND status = 'active') THEN
      INSERT INTO theme_tabs (store_key, key, label, sort_order, status, is_default)
      VALUES (store, spec.key, spec.label, spec.sort_order, 'active', FALSE);
    END IF;
  END LOOP;

  -- 3. tidy the order of the active tabs (All stays first)
  UPDATE theme_tabs SET sort_order = CASE key
      WHEN 'all' THEN 0 WHEN 'mobile' THEN 1 WHEN 'electronics' THEN 2
      WHEN 'headphones' THEN 3 WHEN 'accessories' THEN 4 ELSE sort_order END,
      updated_at = NOW()
   WHERE store_key = store AND status = 'active' AND key IN ('all', 'mobile', 'electronics', 'headphones', 'accessories');

  -- 4. product grid for tabs that have no sections of their own
  SELECT sm.config INTO tmpl
    FROM section_manifests sm JOIN theme_tabs t ON t.id = sm.tab_id
   WHERE t.store_key = store AND sm.section_type = 'category_product_grid' AND sm.shop_id IS NULL
   ORDER BY (t.status = 'active') DESC, sm.created_at LIMIT 1;
  tmpl := COALESCE(tmpl, '{"columns": 2}'::jsonb);

  FOR spec IN
    SELECT * FROM (VALUES
      ('mobile', 'Mobiles', ARRAY['%iphone%','%galaxy%','%oneplus%','%pixel%','%redmi%','%xiaomi%','%realme%','%vivo %','%oppo%','%poco%']),
      ('electronics', 'Top Electronics', ARRAY['%']),
      ('headphones', 'Headphones & Earbuds', ARRAY['%headphone%','%airpods%','%earbud%','%earphone%','%headset%','%neckband%','%buds%']),
      ('accessories', 'Chargers & Accessories', ARRAY['%charger%','%power adapter%','%power bank%','%mouse%','%ssd%','%router%','%cable%','%smartwatch%','%speaker%','%soundbar%'])
    ) AS v(key, title, patterns)
  LOOP
    SELECT * INTO tab_row FROM theme_tabs WHERE store_key = store AND key = spec.key AND status = 'active' LIMIT 1;
    CONTINUE WHEN tab_row.id IS NULL;
    CONTINUE WHEN EXISTS (SELECT 1 FROM section_manifests WHERE tab_id = tab_row.id AND shop_id IS NULL);

    SELECT COALESCE(jsonb_agg(p.id ORDER BY p.created_at), '[]'::jsonb) INTO ids
      FROM products p
     WHERE p.is_active = TRUE AND p.name ILIKE ANY (spec.patterns)
       AND EXISTS (SELECT 1 FROM shop_products sp
                    WHERE sp.product_id = p.id AND sp.deleted_at IS NULL AND sp.stock_quantity >= 1);
    CONTINUE WHEN jsonb_array_length(ids) = 0;

    INSERT INTO section_manifests (tab_id, shop_id, section_type, sort_order, visible, config, merch_binding)
    VALUES (
      tab_row.id, NULL, 'category_product_grid', 0, TRUE,
      tmpl || jsonb_build_object('title', spec.title),
      jsonb_build_object('source', 'manual', 'product_ids', ids, 'category_ids', '[]'::jsonb,
                         'tags', '[]'::jsonb, 'limit', LEAST(12, jsonb_array_length(ids)))
    );
  END LOOP;
END $$;
