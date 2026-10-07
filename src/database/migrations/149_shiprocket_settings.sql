-- 149_shiprocket_settings.sql
-- Dashboard-managed Shiprocket API-user credentials (Settings -> API Users
-- in the Shiprocket panel). Singleton row, same shape as razorpay_settings
-- (132). The password is encrypted at rest via src/utils/encryption.js.
CREATE TABLE IF NOT EXISTS shiprocket_settings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_email             TEXT NULL,
  api_password_encrypted TEXT NULL,
  pickup_location       TEXT NULL,
  last_tested_at        TIMESTAMPTZ NULL,
  last_test_status      VARCHAR(10) NULL
                         CONSTRAINT chk_shiprocket_test_status CHECK (last_test_status IS NULL OR last_test_status IN ('SUCCESS', 'FAILED')),
  last_test_message     TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            UUID NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shiprocket_settings_singleton
  ON shiprocket_settings ((1));

INSERT INTO shiprocket_settings (api_email)
SELECT NULL
WHERE NOT EXISTS (SELECT 1 FROM shiprocket_settings);
