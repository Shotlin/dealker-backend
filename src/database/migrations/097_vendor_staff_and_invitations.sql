-- Migration 097: Vendor Staff Invitations & Membership Audit Trail
-- Source of truth: Blueprint §06.1, Phase 2C

-- 1. Vendor Invitations Table
CREATE TABLE IF NOT EXISTS vendor_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('VENDOR_OWNER', 'VENDOR_OPERATOR')) DEFAULT 'VENDOR_OPERATOR',
  token VARCHAR(255) UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'REVOKED')) DEFAULT 'PENDING',
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vendor_email_invitation UNIQUE (vendor_id, email, status)
);

CREATE INDEX IF NOT EXISTS idx_vendor_invitations_token ON vendor_invitations(token);
CREATE INDEX IF NOT EXISTS idx_vendor_invitations_vendor ON vendor_invitations(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invitations_email ON vendor_invitations(email);

-- 2. Vendor Membership Audit Trail Table
CREATE TABLE IF NOT EXISTS vendor_membership_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('INVITE', 'ACCEPT', 'REJECT', 'ROLE_CHANGE', 'SUSPEND', 'REACTIVATE', 'REMOVE')),
  old_role TEXT,
  new_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_audits_vendor ON vendor_membership_audits(vendor_id);

-- 3. Automatic Timestamp Trigger for Invitations
DROP TRIGGER IF EXISTS trg_vendor_invitations_updated_at ON vendor_invitations;
CREATE TRIGGER trg_vendor_invitations_updated_at
  BEFORE UPDATE ON vendor_invitations
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
