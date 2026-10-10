-- Migration 200: customer return flow — problem category + photo/video evidence on refund requests.
-- Additive: old rows keep NULL reason_code and an empty evidence list.
ALTER TABLE refund_requests
  ADD COLUMN IF NOT EXISTS reason_code VARCHAR(40),
  ADD COLUMN IF NOT EXISTS evidence    JSONB NOT NULL DEFAULT '[]'::jsonb;
