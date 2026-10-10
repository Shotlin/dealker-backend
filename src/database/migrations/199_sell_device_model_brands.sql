-- 199_sell_device_model_brands.sql
-- The Exchange flow in the customer app groups trade-in models by BRAND (logo tiles) and shows a model picture.
--   brand           display name, e.g. 'Apple'
--   brand_logo_url  absolute URL of the logo (uploaded to /uploads/brands/ by scripts/seed-exchange-brand-logos.mjs)
--   image_url       optional model photo
-- Additive and idempotent. Existing models get a brand from their name; logos are filled in by the seed script.
ALTER TABLE sell_device_models
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS brand_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT;

UPDATE sell_device_models SET brand = CASE
    WHEN name ILIKE 'iphone%' OR name ILIKE 'ipad%' OR name ILIKE 'macbook%' THEN 'Apple'
    WHEN name ILIKE 'samsung%' THEN 'Samsung'
    WHEN name ILIKE 'oneplus%' THEN 'OnePlus'
    WHEN name ILIKE 'redmi%' OR name ILIKE 'xiaomi%' OR name ILIKE 'poco%' THEN 'Xiaomi'
    WHEN name ILIKE 'realme%' THEN 'Realme'
    WHEN name ILIKE 'oppo%' THEN 'Oppo'
    WHEN name ILIKE 'vivo%' THEN 'Vivo'
    WHEN name ILIKE 'lenovo%' THEN 'Lenovo'
    WHEN name ILIKE 'pixel%' OR name ILIKE 'google%' THEN 'Google'
    ELSE brand
  END
WHERE brand IS NULL;
