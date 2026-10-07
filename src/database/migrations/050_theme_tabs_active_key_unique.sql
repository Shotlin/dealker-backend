-- 050_theme_tabs_active_key_unique.sql
-- ---------------------------------------------------------------------------
-- Problem:
--   The unique index idx_theme_tabs_store_key_key on (store_key, key) covered
--   ALL rows regardless of status. Archived tabs therefore permanently
--   "locked" their key, so creating or renaming an active tab to a key that
--   an archived tab already used raised a 23505 unique violation (surfaced to
--   the dashboard as a 409 / 500). Editing the icon of a tab whose key matched
--   an archived sibling failed for the same reason.
--
-- Fix:
--   Replace the full unique index with a PARTIAL unique index that only
--   enforces uniqueness among ACTIVE tabs. Archived tabs may freely share a
--   key with an active tab (or with each other), which is the desired
--   behaviour: archiving frees the key for reuse.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_theme_tabs_store_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_tabs_active_store_key_key
  ON theme_tabs (store_key, key)
  WHERE status = 'active';
