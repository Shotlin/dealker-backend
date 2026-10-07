-- Migration 113: Theme tabs default-landing-tab flag
-- (bakaloo: 109_theme_tabs_default_flag.sql, renumbered — 109 collides with
-- an unrelated meet-commerce migration)
--
-- Lets admins mark one tab per store as the tab customers land on when the
-- app opens, instead of the app hardcoding the "all" tab key. The admin
-- theme-tabs module (src/modules/admin/theme-tabs/theme-tabs.service.js and
-- src/modules/theme-tabs/theme-tabs.repository.js) already reference this
-- column and a matching one-default-per-store unique index — they were
-- written against this schema but the migration adding it was never created.

ALTER TABLE theme_tabs ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_tabs_one_default_per_store
  ON theme_tabs (store_key)
  WHERE is_default = true AND status = 'active';
