-- Storefront sections are Dealker's own: Marketplace (home), Mega Deals, Brand Store, New Arrivals.
ALTER TABLE theme_tabs DROP CONSTRAINT IF EXISTS theme_tabs_store_key_check;
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'theme_tabs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%store_key%' LOOP
    EXECUTE format('ALTER TABLE theme_tabs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

UPDATE theme_tabs SET store_key = 'marketplace'  WHERE store_key = 'zepto';
UPDATE theme_tabs SET store_key = 'deals'        WHERE store_key = 'off_zone';
UPDATE theme_tabs SET store_key = 'brand_store'  WHERE store_key = 'super_mall';
UPDATE theme_tabs SET store_key = 'new_arrivals' WHERE store_key = 'cafe';
UPDATE theme_analytics SET store_key = 'marketplace'  WHERE store_key = 'zepto';
UPDATE theme_analytics SET store_key = 'deals'        WHERE store_key = 'off_zone';
UPDATE theme_analytics SET store_key = 'brand_store'  WHERE store_key = 'super_mall';
UPDATE theme_analytics SET store_key = 'new_arrivals' WHERE store_key = 'cafe';

ALTER TABLE theme_tabs ADD CONSTRAINT theme_tabs_store_key_check
  CHECK (store_key IN ('marketplace', 'deals', 'brand_store', 'new_arrivals'));

-- Grocery-flavoured demo tab labels → marketplace categories
UPDATE theme_tabs SET label = 'Home & Kitchen' WHERE key = 'fresh' AND store_key = 'marketplace';
UPDATE theme_tabs SET label = 'Festive Deals'  WHERE key = 'navratri' AND store_key = 'marketplace';
