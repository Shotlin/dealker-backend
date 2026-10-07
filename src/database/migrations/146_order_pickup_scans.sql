-- 146_order_pickup_scans.sql
-- Rider store pickup verification.
--
-- At the store the rider scans the FreshCuts invoice QR
-- (`FRESHCUTS-ORDER|<orderNumber>|<orderId>`, see utils/invoiceGenerator.js)
-- stuck on the order bag. `POST /delivery/pickup-tokens/verify` checks the
-- code belongs to an order this rider has ACCEPTED, records the scan here
-- and returns the price-free packing checklist. The row lets the app
-- recover the checklist after a restart (`GET /delivery/orders/:id/
-- pending-checklist`) and is stamped consumed once pickup is confirmed.
--
-- One row per order: re-scanning by the same rider is idempotent.
CREATE TABLE IF NOT EXISTS order_pickup_scans (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rider_id    UUID NOT NULL REFERENCES users(id),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  CONSTRAINT uq_order_pickup_scans_order UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_pickup_scans_rider
  ON order_pickup_scans (rider_id, verified_at DESC);
