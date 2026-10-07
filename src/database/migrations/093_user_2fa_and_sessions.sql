-- Migration 093: Dashboard User 2FA Settings and Device Session Management
-- Additive DDL for Meet Commerce security & session control (Blueprint §05.1, §05.2)

-- Helper Trigger Function for Automatic updated_at Timestamps
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. User 2FA Settings Table
CREATE TABLE IF NOT EXISTS user_2fa_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'TOTP' CHECK (method IN ('TOTP', 'SMS', 'EMAIL')),
  secret_hash TEXT NOT NULL,
  recovery_codes_hash TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to auto-update updated_at timestamp on row modification
DROP TRIGGER IF EXISTS trg_user_2fa_settings_updated_at ON user_2fa_settings;
CREATE TRIGGER trg_user_2fa_settings_updated_at
  BEFORE UPDATE ON user_2fa_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

COMMENT ON TABLE user_2fa_settings IS 'Stores 2FA configuration, TOTP secret hashes, and recovery code hashes for dashboard users';
COMMENT ON COLUMN user_2fa_settings.method IS 'Supported 2FA method: TOTP | SMS | EMAIL';

-- 2. User Device Sessions Table
CREATE TABLE IF NOT EXISTS user_device_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  device_fingerprint TEXT NOT NULL,
  ip_address INET, -- PostgreSQL INET datatype with built-in IPv4/IPv6 validation
  user_agent TEXT,
  device_type TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (device_type IN ('MOBILE_APP', 'WEB_DASHBOARD', 'TABLET', 'UNKNOWN')),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_device_sessions_user ON user_device_sessions(user_id, is_revoked, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_device_sessions_fingerprint ON user_device_sessions(device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_user_device_sessions_version ON user_device_sessions(user_id, session_version);

COMMENT ON TABLE user_device_sessions IS 'Tracks per-device active login sessions, device fingerprints, and revocation state';
COMMENT ON COLUMN user_device_sessions.ip_address IS 'Validated IPv4 or IPv6 address using native PostgreSQL INET type';
COMMENT ON COLUMN user_device_sessions.device_type IS 'Device category: MOBILE_APP | WEB_DASHBOARD | TABLET | UNKNOWN';
