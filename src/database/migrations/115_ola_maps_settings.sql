-- 115_ola_maps_settings.sql
-- Admin-configurable Ola Maps (https://maps.olakrutrim.com) integration —
-- lets the API key be pasted, tested, and rotated from the dashboard at
-- any time with no redeploy, replacing the OLA_MAPS_API_KEY env var.
-- Single GLOBAL row, same singleton shape as fee_settings (migration 055).

CREATE TABLE IF NOT EXISTS ola_maps_settings (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  api_key            TEXT NULL,
  is_enabled         BOOLEAN NOT NULL DEFAULT false,

  -- Result of the last "Test Connection" check run from the dashboard
  -- (also re-run automatically whenever the key is changed via Save).
  last_tested_at     TIMESTAMPTZ NULL,
  last_test_status   VARCHAR(10) NULL
                     CONSTRAINT chk_oms_last_test_status
                     CHECK (last_test_status IS NULL OR last_test_status IN ('SUCCESS', 'FAILED')),
  last_test_message  TEXT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

-- Exactly one row — same "functional index on a constant" trick as
-- uq_fee_settings_global.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ola_maps_settings_singleton
  ON ola_maps_settings ((1));

-- Seed the single row, unconfigured until an admin pastes a key.
INSERT INTO ola_maps_settings (api_key, is_enabled)
SELECT NULL, false
WHERE NOT EXISTS (SELECT 1 FROM ola_maps_settings);
