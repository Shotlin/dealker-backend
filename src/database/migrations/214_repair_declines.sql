-- Repair marketplace: a service centre can "Reject" an incoming request (it moves to the Rejected tab, nothing is sent to the customer).
CREATE TABLE IF NOT EXISTS repair_request_declines (
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  reason VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_repair_declines_vendor ON repair_request_declines (vendor_id, created_at DESC);
