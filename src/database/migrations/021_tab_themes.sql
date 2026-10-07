-- 021_tab_themes.sql
-- Extend app_themes for tab-based dynamic theming and create support tables

-- Tab association
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS tab_key VARCHAR(50);
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS tab_label VARCHAR(100);
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS tab_icon_url TEXT;
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS tab_order INT DEFAULT 0;

-- Lifecycle management
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft';
-- Allowed: 'draft', 'active', 'scheduled', 'archived'

-- Scheduling
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Theme inheritance
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS base_theme_id UUID REFERENCES app_themes(id);

-- A/B testing
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS ab_variant VARCHAR(1) DEFAULT 'A';
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS ab_split_percent INT DEFAULT 100;

-- Versioning + ETag
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;
ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS etag VARCHAR(64);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_themes_tab_key ON app_themes(tab_key);
CREATE INDEX IF NOT EXISTS idx_themes_status ON app_themes(status);
CREATE INDEX IF NOT EXISTS idx_themes_scheduled
  ON app_themes(scheduled_at)
  WHERE status = 'scheduled';

-- Update existing row: set tab_key and status for the Summer 2026 theme
UPDATE app_themes
SET
  tab_key = 'all',
  tab_label = 'All',
  tab_order = 0,
  status = 'active'
WHERE name = 'Summer 2026' AND tab_key IS NULL;

-- Version history table
CREATE TABLE IF NOT EXISTS app_theme_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id UUID NOT NULL REFERENCES app_themes(id) ON DELETE CASCADE,
  version INT NOT NULL,
  theme_data JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_theme_versions_theme
  ON app_theme_versions(theme_id, version DESC);

-- Analytics table
CREATE TABLE IF NOT EXISTS theme_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id UUID REFERENCES app_themes(id) ON DELETE SET NULL,
  tab_key VARCHAR(50) NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  user_id UUID,
  session_id VARCHAR(64),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_theme
  ON theme_analytics(theme_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_tab
  ON theme_analytics(tab_key, created_at DESC);
