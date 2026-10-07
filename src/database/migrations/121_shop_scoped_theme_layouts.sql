-- A visual storefront can share the same tab names across fulfilment shops,
-- while each shop needs its own ordered home layout. Global rows remain the
-- default; shop rows are copied from that default only when an admin first
-- opens a shop in Theme Builder.
ALTER TABLE section_manifests
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_section_manifests_tab_shop_order
  ON section_manifests (tab_id, shop_id, sort_order);

CREATE TABLE IF NOT EXISTS section_layout_scopes (
  tab_id UUID NOT NULL REFERENCES theme_tabs(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tab_id, shop_id)
);
