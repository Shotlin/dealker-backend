-- 132_razorpay_settings.sql
-- Dashboard-managed Razorpay credentials — replaces reading
-- RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET from the
-- server's .env file with a single admin-editable, encrypted-at-rest
-- source of truth. Two independent credential sets (TEST and PRODUCTION)
-- so a store can safely test in TEST mode before ever touching live
-- money; `active_mode` picks which one src/config/razorpay.js actually
-- uses. Same singleton shape as ola_maps_settings (115) / support_settings
-- (131) — one GLOBAL row via a unique index on a constant expression.
--
-- key_secret / webhook_secret are stored via src/utils/encryption.js
-- (AES-256-GCM, env SETTINGS_ENCRYPTION_KEY) — never plaintext. key_id is
-- not itself a secret (Razorpay's own client-side checkout SDK is handed
-- it directly), but the dashboard still masks it in the UI per the
-- explicit product spec.
--
-- Existing orders/payments rows are untouched by this migration or by any
-- later credential edit/activation — see src/config/razorpay.js and
-- src/modules/razorpay-settings/* for the read/write paths.

CREATE TABLE IF NOT EXISTS razorpay_settings (
  id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  active_mode                     VARCHAR(10) NOT NULL DEFAULT 'TEST'
                                   CONSTRAINT chk_rzp_active_mode CHECK (active_mode IN ('TEST', 'PRODUCTION')),

  test_key_id                     TEXT NULL,
  test_key_secret_encrypted       TEXT NULL,
  test_webhook_secret_encrypted   TEXT NULL,
  test_last_tested_at             TIMESTAMPTZ NULL,
  test_last_test_status           VARCHAR(10) NULL
                                   CONSTRAINT chk_rzp_test_status CHECK (test_last_test_status IS NULL OR test_last_test_status IN ('SUCCESS', 'FAILED')),
  test_last_test_message          TEXT NULL,

  live_key_id                     TEXT NULL,
  live_key_secret_encrypted       TEXT NULL,
  live_webhook_secret_encrypted   TEXT NULL,
  live_last_tested_at             TIMESTAMPTZ NULL,
  live_last_test_status           VARCHAR(10) NULL
                                   CONSTRAINT chk_rzp_live_status CHECK (live_last_test_status IS NULL OR live_last_test_status IN ('SUCCESS', 'FAILED')),
  live_last_test_message          TEXT NULL,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                      UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

-- Exactly one row — same "functional index on a constant" trick as
-- uq_ola_maps_settings_singleton / uq_fee_settings_global.
CREATE UNIQUE INDEX IF NOT EXISTS uq_razorpay_settings_singleton
  ON razorpay_settings ((1));

-- Seed the single row, unconfigured (TEST active, no credentials saved)
-- until an admin fills the dashboard form. src/config/razorpay.js falls
-- back to the legacy env vars whenever this row has no usable credentials
-- for its active_mode, so existing prod payment flows are never broken by
-- this migration alone.
INSERT INTO razorpay_settings (active_mode)
SELECT 'TEST'
WHERE NOT EXISTS (SELECT 1 FROM razorpay_settings);
