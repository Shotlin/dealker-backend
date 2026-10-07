-- Soft-delete for addresses: removing an address used to hard-delete the
-- row immediately, losing the record for good. For security/dispute
-- review (matching an order back to the address it was delivered to) we
-- now keep the row for a retention window and only purge it later via a
-- scheduled job — same pattern as 059_products_deleted_at.sql.

ALTER TABLE addresses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_addresses_deleted_at ON addresses(deleted_at) WHERE deleted_at IS NOT NULL;
