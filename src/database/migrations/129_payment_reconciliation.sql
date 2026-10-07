-- 129_payment_reconciliation.sql
-- Razorpay payment-reconciliation hardening: manual-review/recovery
-- tracking, decline-reason capture, and webhook event deduplication.
--
-- `needs_manual_review` / `recovered_from_failed` as real boolean columns
-- (not JSONB metadata keys) so the admin dashboard can filter/count them
-- with a plain WHERE clause instead of a JSON path expression.
--
-- `payment_webhook_events` backs `PaymentsRepository#recordWebhookEvent`,
-- which already existed in the codebase (with an `ON CONFLICT (provider,
-- provider_event_id) DO NOTHING` dedup clause) but was never actually
-- migrated — the table this method inserts into has never existed in any
-- deployed database, so every call to it would throw
-- "relation payment_webhook_events does not exist". This migration creates
-- it so that dead-but-referenced code becomes real.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS needs_manual_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovered_from_failed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason VARCHAR(60),
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS error_description TEXT,
  ADD COLUMN IF NOT EXISTS error_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS error_step VARCHAR(50),
  ADD COLUMN IF NOT EXISTS error_reason VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_payments_needs_manual_review
  ON payments(needs_manual_review)
  WHERE needs_manual_review = true;

CREATE INDEX IF NOT EXISTS idx_payments_recovered_from_failed
  ON payments(recovered_from_failed)
  WHERE recovered_from_failed = true;

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider           VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
  provider_event_id  VARCHAR(150) NOT NULL,
  event_type         VARCHAR(50) NOT NULL,
  payload_hash       VARCHAR(64),
  signature_valid    BOOLEAN NOT NULL DEFAULT true,
  processing_status  VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
  last_error         TEXT,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_type
  ON payment_webhook_events(event_type, created_at DESC);
