-- 024_section_manifests.sql
-- Section manifest schema and version history for per-tab homepage layouts
-- Note: migrate.js already wraps each migration file in a transaction.

CREATE TABLE IF NOT EXISTS section_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id UUID NOT NULL REFERENCES theme_tabs(id) ON DELETE CASCADE,
  section_type VARCHAR(50) NOT NULL
    CHECK (section_type IN (
      'animated_banner',
      'fee_strip',
      'seasonal_mosaic',
      'round_category_icons',
      'category_product_grid',
      'product_carousel',
      'trending_products',
      'promo_carousel',
      'bank_offers',
      'custom_banner',
      'text_header',
      'spacer'
    )),
  sort_order INT NOT NULL DEFAULT 0,
  visible BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  merch_binding JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS section_manifest_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id UUID NOT NULL REFERENCES theme_tabs(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  snapshot JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  scheduled_at TIMESTAMPTZ DEFAULT NULL,
  status VARCHAR(20) DEFAULT 'applied'
    CHECK (status IN ('applied', 'scheduled', 'expired')),
  ab_variant CHAR(1) DEFAULT 'A'
    CHECK (ab_variant IN ('A', 'B')),
  ab_split_percent INT DEFAULT 0
    CHECK (ab_split_percent BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_section_manifests_tab_order
  ON section_manifests(tab_id, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_section_manifests_type
  ON section_manifests(section_type);

CREATE INDEX IF NOT EXISTS idx_section_versions_tab
  ON section_manifest_versions(tab_id, version DESC);

CREATE OR REPLACE FUNCTION update_section_manifests_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_section_manifests_updated_at ON section_manifests;
CREATE TRIGGER trg_section_manifests_updated_at
  BEFORE UPDATE ON section_manifests
  FOR EACH ROW
  EXECUTE FUNCTION update_section_manifests_timestamp();
