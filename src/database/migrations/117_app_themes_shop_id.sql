-- 117_app_themes_shop_id.sql
-- Per-store theming: a theme can now target one physical shop (Kolkata,
-- Delhi, ...) instead of only the whole app. shop_id IS NULL keeps meaning
-- "the platform default theme" — the fallback for anonymous customers and
-- any customer with no shop allocation yet, preserving today's behavior.

ALTER TABLE app_themes
  ADD COLUMN IF NOT EXISTS shop_id UUID NULL REFERENCES shops(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_app_themes_shop_id ON app_themes(shop_id);

-- Replace the old "one active theme, period" constraint with "one active
-- theme per shop_id bucket" — NULL shop_id is its own bucket (the global
-- default), coalesced to a sentinel so multiple NULL rows can't slip past
-- the uniqueness check the way a plain UNIQUE(shop_id) would allow.
DROP INDEX IF EXISTS idx_one_active_theme;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_theme_per_shop
  ON app_themes (COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active = true;
