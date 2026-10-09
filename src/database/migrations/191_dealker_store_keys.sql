-- Dealker's home has five top-level stores (Mobile, Mobile Part, Accessories,
-- Electronics, Repellents & Fresheners). Additive: the earlier storefront keys
-- stay valid so existing tabs/themes are untouched.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'theme_tabs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%store_key%' LOOP
    EXECUTE format('ALTER TABLE theme_tabs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE theme_tabs ADD CONSTRAINT theme_tabs_store_key_check
  CHECK (store_key IN ('mobile', 'mobile_part', 'accessories', 'electronics', 'repellents',
                       'marketplace', 'deals', 'brand_store', 'new_arrivals'));

-- Top-of-home store tiles (label / icon / order). Public read via GET /api/v1/theme/stores.
CREATE TABLE IF NOT EXISTS storefront_stores (
  store_key   VARCHAR(50) PRIMARY KEY CHECK (store_key IN ('mobile', 'mobile_part', 'accessories', 'electronics', 'repellents',
                                                            'marketplace', 'deals', 'brand_store', 'new_arrivals')),
  label       VARCHAR(100) NOT NULL,
  icon_url    TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO storefront_stores (store_key, label, sort_order) VALUES
  ('mobile', 'Mobile', 0),
  ('mobile_part', 'Mobile Part', 1),
  ('accessories', 'Accessories', 2),
  ('electronics', 'Electronics', 3),
  ('repellents', 'Repellents & Fresheners', 4)
ON CONFLICT (store_key) DO NOTHING;
