-- 131_support_settings.sql
-- Centralized brand name / support phone / support email — the single
-- source of truth for every "Need Help" / "Contact Us" surface across the
-- mobile app (Order Details, Profile), replacing the hardcoded
-- AppConstants.supportPhone/supportEmail values that could only ever be
-- changed by shipping a new app build. Single GLOBAL row, same singleton
-- shape as fee_settings (055) / ola_maps_settings (115).

CREATE TABLE IF NOT EXISTS support_settings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  brand_name     TEXT NOT NULL DEFAULT 'FreshCuts',
  support_phone  TEXT NULL,
  support_email  TEXT NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

-- Exactly one row — same "functional index on a constant" trick as
-- uq_ola_maps_settings_singleton / uq_fee_settings_global.
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_settings_singleton
  ON support_settings ((1));

-- Seed the single row. Real values still need an admin to fill them in via
-- the dashboard (never fabricated here) — an absent phone/email means the
-- corresponding row is hidden client-side, never shown broken.
INSERT INTO support_settings (brand_name, support_phone, support_email)
SELECT 'FreshCuts', NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM support_settings);
