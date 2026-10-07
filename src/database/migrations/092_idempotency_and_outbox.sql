-- Migration 092: Idempotency Keys, Transactional Outbox Events, and Provider Webhooks
-- Additive DDL for Meet Commerce platform reliability (Blueprint §04.3, §04.4, §04.5)

-- 1. Idempotency Keys Table
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash CHAR(64) NOT NULL, -- Strict SHA-256 hex string length
  response_snapshot JSONB,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETE', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uix_idempotency_keys_key_user ON idempotency_keys(key, user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);

COMMENT ON TABLE idempotency_keys IS 'Stores request idempotency tokens to prevent duplicate execution of state-changing commands';
COMMENT ON COLUMN idempotency_keys.request_hash IS 'SHA-256 hash (64 hex chars) of HTTP request payload for duplicate payload validation';
COMMENT ON COLUMN idempotency_keys.status IS 'Lifecycle status: PROCESSING | COMPLETE | FAILED';

-- 2. Transactional Outbox Events Table
CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL, -- Mandatory payload; no empty default to prevent hidden bugs
  correlation_id UUID,
  causation_id UUID,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;

COMMENT ON TABLE outbox_events IS 'Transactional outbox for domain events emitted during PostgreSQL state updates';
COMMENT ON COLUMN outbox_events.published_at IS 'Timestamp when worker successfully published event to BullMQ / event bus; NULL indicates pending publish';

-- 3. Provider Webhook Events Table
CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('RAZORPAY', 'WHATSAPP', 'SMS', 'MEDIA_SCAN')),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  raw_payload JSONB NOT NULL, -- Native JSONB for queryable webhook payload inspection
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uix_webhook_provider_event ON provider_webhook_events(provider, provider_event_id);

COMMENT ON TABLE provider_webhook_events IS 'Audit and deduplication store for raw incoming third-party webhooks';
COMMENT ON COLUMN provider_webhook_events.provider IS 'Provider identifier: RAZORPAY | WHATSAPP | SMS | MEDIA_SCAN';
