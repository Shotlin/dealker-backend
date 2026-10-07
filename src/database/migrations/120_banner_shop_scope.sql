-- Storefront banners may be global (NULL) or assigned to one shop.
-- Existing rows stay global so this migration is backwards compatible.
ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_banners_active_shop
  ON banners(shop_id, display_order)
  WHERE is_active = true;
