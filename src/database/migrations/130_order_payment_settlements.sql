-- Manual payment settlement (admin/finance dashboard) — for orders delivered
-- without going through the rider app / online payment flow, an admin needs
-- to record that cash/UPI was actually collected from the customer.
--
-- Immutable audit log, never overwritten or deleted: a SETTLEMENT row
-- records money received; correcting a mistake is a REVERSAL row pointing
-- back at the original (`reverses_entry_id`), never an edit/delete of it.
-- `orders.payment_status` (PENDING / PARTIALLY_PAID / PAID) is derived from
-- summing this table's rows (SETTLEMENT positive, REVERSAL negative of the
-- same amount) against `orders.total_payable - orders.wallet_amount`.
CREATE TABLE IF NOT EXISTS order_payment_settlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  entry_type VARCHAR(20) NOT NULL DEFAULT 'SETTLEMENT',
  amount NUMERIC(10,2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  cash_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  upi_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  reference VARCHAR(150),
  method_note TEXT,
  internal_note TEXT,
  reverses_entry_id UUID REFERENCES order_payment_settlements(id),
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_payment_settlements_order
  ON order_payment_settlements(order_id, created_at);
