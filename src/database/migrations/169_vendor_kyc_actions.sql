ALTER TABLE vendor_kyc_reviews DROP CONSTRAINT IF EXISTS vendor_kyc_reviews_action_check;
ALTER TABLE vendor_kyc_reviews ADD CONSTRAINT vendor_kyc_reviews_action_check
  CHECK (action IN ('SUBMIT', 'START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CORRECTION', 'ACTIVATE', 'SUSPEND', 'REINSTATE'));
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
