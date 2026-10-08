-- 175_sell_request_exchange_order.sql
-- Link an EXCHANGE sell request to the order for the new product. One order can settle
-- at most one trade-in. Additive & idempotent.

ALTER TABLE sell_requests
  ADD COLUMN IF NOT EXISTS exchange_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exchange_linked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exchange_linked_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sell_requests_exchange_order
  ON sell_requests (exchange_order_id) WHERE exchange_order_id IS NOT NULL;

COMMENT ON COLUMN sell_requests.exchange_order_id IS 'Order for the new product bought against this trade-in. Required before an EXCHANGE request can be COMPLETED.';
