-- Migration 096: Vendor KYC Documents & Review History
-- Source of truth: Blueprint §06.1, Phase 2B

-- 1. Update vendors status constraint to include UNDER_REVIEW, CORRECTION_REQUIRED, REJECTED
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_status_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_status_check
  CHECK (status IN ('PENDING_ONBOARDING', 'KYC_SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'VERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'REJECTED'));

-- 2. Vendor KYC Documents Table
CREATE TABLE IF NOT EXISTS vendor_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('TRADE_LICENSE', 'GSTIN_CERTIFICATE', 'FSSAI_LICENSE', 'PAN_CARD', 'BANK_CANCELLED_CHEQUE', 'OTHER')),
  document_number VARCHAR(100),
  file_key VARCHAR(255) NOT NULL,
  file_url VARCHAR(512),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')) DEFAULT 'PENDING',
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_documents_vendor ON vendor_documents(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_documents_type ON vendor_documents(document_type);

-- 3. Vendor KYC Review History Table
CREATE TABLE IF NOT EXISTS vendor_kyc_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('SUBMIT', 'START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CORRECTION')),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_kyc_reviews_vendor ON vendor_kyc_reviews(vendor_id);

-- 4. Automatic Timestamp Trigger
DROP TRIGGER IF EXISTS trg_vendor_documents_updated_at ON vendor_documents;
CREATE TRIGGER trg_vendor_documents_updated_at
  BEFORE UPDATE ON vendor_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();
