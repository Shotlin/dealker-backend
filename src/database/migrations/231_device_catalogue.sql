-- 231_device_catalogue.sql
-- One shared phone catalogue (brands -> series -> models -> storage) for Sell, Repair, Exchange, vendor Add-Product,
-- bulk add, demand posts and auctions. Built on the existing sell_device_models table so nothing that already reads it breaks.
--   * model rows keep a stable uuid (id); the name stays unique
--   * `variants` = the storage sizes of the model (ascending), `colors` = colour choices
--   * base_price may now be NULL ("no catalogue price"): the Sell flow then asks the seller for the price he expects
--   * sale_enabled / repair_enabled switch a model on or off per module without touching code (admin editable)
ALTER TABLE sell_device_models DROP CONSTRAINT IF EXISTS sell_device_models_base_price_check;
ALTER TABLE sell_device_models ALTER COLUMN base_price DROP NOT NULL;
ALTER TABLE sell_device_models ADD CONSTRAINT sell_device_models_base_price_check CHECK (base_price IS NULL OR base_price > 0);

ALTER TABLE sell_device_models
  ADD COLUMN IF NOT EXISTS series         TEXT,
  ADD COLUMN IF NOT EXISTS sale_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS repair_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS display_order  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sell_device_models_brand ON sell_device_models (lower(brand), display_order, name);

CREATE TABLE IF NOT EXISTS device_brands (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  logo_url    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  popular     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_brands_name_key ON device_brands (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS device_brands_slug_key ON device_brands (slug);
