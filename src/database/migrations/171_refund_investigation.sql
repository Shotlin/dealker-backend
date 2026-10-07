-- 171_refund_investigation.sql
-- Internal "case file" for a refund request. Everything here is staff-only: the customer
-- never sees investigation status, notes, call logs or evidence reviews.
--
--   refund_requests          + investigation_* columns (status, owner, deadline, findings, verdict, checklist)
--   refund_case_events       append-only audit trail: who did what, and when
--   refund_case_evidence     proof gathered from the customer, the seller, the courier or our own team

ALTER TABLE refund_requests
  ADD COLUMN IF NOT EXISTS investigation_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (investigation_status IN ('NOT_STARTED', 'OPEN', 'WAITING_CUSTOMER', 'WAITING_SELLER', 'READY_TO_DECIDE', 'DECIDED')),
  ADD COLUMN IF NOT EXISTS investigation_owner UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS investigation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS investigation_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS investigation_findings TEXT,
  ADD COLUMN IF NOT EXISTS investigation_verdict TEXT
    CHECK (investigation_verdict IN ('CUSTOMER_RIGHT', 'SELLER_RIGHT', 'PARTLY_BOTH')),
  -- { "<check key>": { "done": true, "by": "<user id>", "at": "<iso>", "note": "..." } }
  ADD COLUMN IF NOT EXISTS verification JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_refund_requests_investigation
  ON refund_requests (investigation_status, investigation_due_at)
  WHERE investigation_status <> 'NOT_STARTED';

CREATE TABLE IF NOT EXISTS refund_case_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_request_id  UUID NOT NULL REFERENCES refund_requests(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN (
                       'REQUEST_CREATED', 'INVESTIGATION_STARTED', 'STATUS_CHANGED', 'OWNER_CHANGED', 'DEADLINE_CHANGED',
                       'NOTE', 'CALL', 'EVIDENCE_ADDED', 'EVIDENCE_REVIEWED', 'EVIDENCE_REMOVED', 'CHECK_DONE', 'CHECK_UNDONE',
                       'FINDINGS_SAVED', 'APPROVED', 'REJECTED', 'CHAT_STARTED')),
  -- Who the entry is about: the person we spoke to / the side the proof came from.
  party              TEXT CHECK (party IN ('CUSTOMER', 'SELLER', 'COURIER', 'TEAM')),
  title              TEXT NOT NULL,
  body               TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refund_case_events_req ON refund_case_events (refund_request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refund_case_evidence (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_request_id  UUID NOT NULL REFERENCES refund_requests(id) ON DELETE CASCADE,
  side               TEXT NOT NULL CHECK (side IN ('CUSTOMER', 'SELLER', 'COURIER', 'TEAM')),
  kind               TEXT NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'AUDIO', 'INVOICE', 'DOCUMENT')),
  url                TEXT NOT NULL,
  title              TEXT NOT NULL,
  note               TEXT,
  -- Our own verdict on this piece of proof.
  review             TEXT NOT NULL DEFAULT 'UNREVIEWED' CHECK (review IN ('UNREVIEWED', 'SUPPORTS_CUSTOMER', 'SUPPORTS_SELLER', 'NOT_USEFUL')),
  review_note        TEXT,
  reviewed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  uploaded_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refund_case_evidence_req ON refund_case_evidence (refund_request_id, created_at);
