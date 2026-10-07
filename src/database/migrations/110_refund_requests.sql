-- Migration 110: Returns / RMA — refund_requests table
-- Admin-mediated return/refund workflow: PENDING -> APPROVED/REJECTED/CANCELLED.
-- Refund amount is always server-computed at request-creation time from the
-- real order (full order total, or the sum of selected item line totals) —
-- never client-supplied, and never editable after creation.

CREATE TABLE refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  customer_id UUID NOT NULL REFERENCES users(id),

  scope VARCHAR(20) NOT NULL CHECK (scope IN ('FULL_ORDER', 'ITEMS')),
  -- Array of { itemIndex, name, quantity, unitPrice, lineTotal } — null for FULL_ORDER scope.
  -- itemIndex refers to the position within the order's own `items` JSONB array
  -- (order line items have no standalone id).
  items JSONB,

  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  refund_destination VARCHAR(20) NOT NULL CHECK (refund_destination IN ('RAZORPAY', 'WALLET')),

  computed_amount NUMERIC(10,2) NOT NULL,
  resolved_amount NUMERIC(10,2),

  admin_notes TEXT,
  requested_by UUID REFERENCES users(id),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refund_requests_order ON refund_requests(order_id);
CREATE INDEX idx_refund_requests_customer ON refund_requests(customer_id);
CREATE INDEX idx_refund_requests_status ON refund_requests(status);
CREATE INDEX idx_refund_requests_created_at ON refund_requests(created_at DESC);
