-- 230_vendor_returns.sql
-- Vendor side of customer returns (additive).
--
-- A customer's refund request (refund_requests) is decided by the Dealker team. The vendor can now see the
-- requests that touch their own order lines and answer them: "I agree to the return" or "I dispute it",
-- with a note and optional photos. The answer is advisory — the team still approves / rejects and moves the
-- money — and lands in the staff case file (refund_case_events + refund_case_evidence, side SELLER).
--
--   refund_vendor_responses   one row per (refund request, vendor) — upserted when the vendor changes their answer

CREATE TABLE IF NOT EXISTS refund_vendor_responses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_request_id  UUID NOT NULL REFERENCES refund_requests(id) ON DELETE CASCADE,
  vendor_id          UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  responded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  stance             TEXT NOT NULL CHECK (stance IN ('AGREE', 'DISPUTE')),
  note               TEXT NOT NULL,
  -- [{ "url": "...", "kind": "IMAGE" | "VIDEO" }]
  evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- refund_case_evidence rows created from this answer (replaced when the vendor answers again)
  case_evidence_ids  UUID[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_refund_vendor_response UNIQUE (refund_request_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_refund_vendor_responses_vendor ON refund_vendor_responses (vendor_id, created_at DESC);

-- The case file gets one more kind of entry.
ALTER TABLE refund_case_events DROP CONSTRAINT IF EXISTS refund_case_events_type_check;
ALTER TABLE refund_case_events ADD CONSTRAINT refund_case_events_type_check CHECK (type IN (
  'REQUEST_CREATED', 'INVESTIGATION_STARTED', 'STATUS_CHANGED', 'OWNER_CHANGED', 'DEADLINE_CHANGED',
  'NOTE', 'CALL', 'EVIDENCE_ADDED', 'EVIDENCE_REVIEWED', 'EVIDENCE_REMOVED', 'CHECK_DONE', 'CHECK_UNDONE',
  'FINDINGS_SAVED', 'APPROVED', 'REJECTED', 'CHAT_STARTED', 'SELLER_RESPONDED'));

-- Vendor-side lookup: "my chat for this return".
CREATE INDEX IF NOT EXISTS idx_support_tickets_vendor_return ON support_tickets (refund_request_id, user_id) WHERE channel = 'VENDOR_APP';
