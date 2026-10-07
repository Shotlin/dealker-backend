-- Admin rejection of a rider document never persisted a reason — the
-- note passed from the dashboard's "Reject" action was accepted by
-- the API but silently dropped because there was nowhere to store
-- it. The rider app already parses rejectionReason/rejection_reason
-- (see RiderDocument.fromJson on the client), so it just needed a
-- column to read from.

ALTER TABLE rider_documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
