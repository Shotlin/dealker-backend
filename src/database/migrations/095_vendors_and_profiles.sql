-- Migration 095: Vendors, Vendor Users, Vendor Profiles, Vendor Settings & Compatibility Views
-- Source of truth: Blueprint §04.1, §06.1, Phase 2A

-- 1. Vendors Table
CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_ONBOARDING', 'KYC_SUBMITTED', 'VERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')) DEFAULT 'PENDING_ONBOARDING',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_vendors_slug ON vendors(slug);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
CREATE INDEX IF NOT EXISTS idx_vendors_is_active ON vendors(is_active) WHERE deleted_at IS NULL;

-- 2. Vendor Users Table (Ownership & Staff Membership)
CREATE TABLE IF NOT EXISTS vendor_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('VENDOR_OWNER', 'VENDOR_OPERATOR')) DEFAULT 'VENDOR_OPERATOR',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_vendor_user UNIQUE (vendor_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_users_vendor ON vendor_users(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_users_user ON vendor_users(user_id);

-- 3. Vendor Profiles Table (KYC & Address Info)
CREATE TABLE IF NOT EXISTS vendor_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID UNIQUE NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  legal_name VARCHAR(255),
  trade_license_number VARCHAR(100),
  gstin VARCHAR(50),
  fssai_license VARCHAR(100),
  pan_number VARCHAR(50),
  address_line1 TEXT,
  address_line2 TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(20),
  latitude NUMERIC(10,8),
  longitude NUMERIC(11,8),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_profiles_vendor ON vendor_profiles(vendor_id);

-- 4. Vendor Settings Table (Operating Config & Financial Rates)
CREATE TABLE IF NOT EXISTS vendor_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID UNIQUE NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  auto_accept_orders BOOLEAN NOT NULL DEFAULT false,
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  payout_schedule TEXT NOT NULL CHECK (payout_schedule IN ('DAILY', 'WEEKLY', 'MONTHLY')) DEFAULT 'WEEKLY',
  notification_email VARCHAR(255),
  notification_phone VARCHAR(20),
  operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_settings_vendor ON vendor_settings(vendor_id);

-- 5. Automatic Timestamp Update Triggers
DROP TRIGGER IF EXISTS trg_vendors_updated_at ON vendors;
CREATE TRIGGER trg_vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_vendor_users_updated_at ON vendor_users;
CREATE TRIGGER trg_vendor_users_updated_at
  BEFORE UPDATE ON vendor_users
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_vendor_profiles_updated_at ON vendor_profiles;
CREATE TRIGGER trg_vendor_profiles_updated_at
  BEFORE UPDATE ON vendor_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_vendor_settings_updated_at ON vendor_settings;
CREATE TRIGGER trg_vendor_settings_updated_at
  BEFORE UPDATE ON vendor_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
