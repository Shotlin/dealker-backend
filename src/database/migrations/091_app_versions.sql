-- 091_app_versions.sql
--
-- Force-update system: lets the admin dashboard raise a "minimum supported
-- build number" per platform at any time, without a new backend deploy or
-- app store review, so an existing install can be required to update the
-- next time it opens.
--
-- Build number (not a semver string like "1.0.3") is the comparison key —
-- Flutter already assigns a monotonically increasing integer per release
-- (pubspec.yaml's `version: 1.0.2+27`, the `+27`), which compares correctly
-- with a plain integer `<` — no risk of the classic "1.0.10" < "1.0.9"
-- lexicographic-string-comparison bug that a semver string would need
-- special parsing to avoid.
--
-- min_supported_build starts at 1 for both platforms (nothing is ever
-- forced by default — every real build has a build number >= 1) until the
-- admin deliberately raises it after a new release is live in both stores.

CREATE TABLE IF NOT EXISTS app_versions (
  platform             VARCHAR(10) PRIMARY KEY,
  min_supported_build  INT NOT NULL DEFAULT 1,
  latest_build         INT NOT NULL DEFAULT 1,
  latest_version_name  VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  update_message       TEXT,
  store_url            TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_app_versions_platform CHECK (platform IN ('android', 'ios'))
);

INSERT INTO app_versions (platform, min_supported_build, latest_build, latest_version_name)
VALUES
  ('android', 1, 1, '1.0.0'),
  ('ios', 1, 1, '1.0.0')
ON CONFLICT (platform) DO NOTHING;
