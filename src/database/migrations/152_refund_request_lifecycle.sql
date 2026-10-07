-- Migration 152: refund request lifecycle (customer-facing refund flow).
--
-- Builds on 110_refund_requests (admin-only RMA table) so the customer app
-- can raise item-level / full-order refund requests that land in the right
-- store's dashboard and sync their status back to the customer.
--
--  * shop_id            — denormalised from orders.shop_id so the store
--                         dashboard can scope/index by branch without a join.
--  * source             — who raised it (CUSTOMER app vs ADMIN on behalf).
--  * PROCESSING status  — transient claim taken while money is being moved,
--                         so a double-click / concurrent approve can never
--                         refund twice. Reverted to PENDING if the money
--                         movement fails (last_error records why).
--  * refund_reference   — Razorpay refund id / wallet txn reference.
--  * one open request per order (PENDING / PROCESSING / APPROVED).

ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id);
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ADMIN';
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS refund_reference TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS last_error TEXT;

UPDATE refund_requests rr
   SET shop_id = o.shop_id
  FROM orders o
 WHERE o.id = rr.order_id AND rr.shop_id IS NULL;

ALTER TABLE refund_requests DROP CONSTRAINT IF EXISTS refund_requests_source_check;
ALTER TABLE refund_requests
  ADD CONSTRAINT refund_requests_source_check CHECK (source IN ('CUSTOMER', 'ADMIN'));

ALTER TABLE refund_requests DROP CONSTRAINT IF EXISTS refund_requests_status_check;
ALTER TABLE refund_requests
  ADD CONSTRAINT refund_requests_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'));

CREATE INDEX IF NOT EXISTS idx_refund_requests_shop_status
  ON refund_requests (shop_id, status, created_at DESC);

-- One live request per order. Guarded: if legacy admin-created rows already
-- violate it, fall back to a plain index instead of failing the deploy (the
-- service layer enforces the same rule either way).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM refund_requests
     WHERE status IN ('PENDING', 'PROCESSING', 'APPROVED')
     GROUP BY order_id HAVING COUNT(*) > 1
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_refund_requests_open_order
      ON refund_requests (order_id) WHERE status IN ('PENDING', 'PROCESSING', 'APPROVED');
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_requests_open_order
      ON refund_requests (order_id) WHERE status IN ('PENDING', 'PROCESSING', 'APPROVED');
  END IF;
END $$;
