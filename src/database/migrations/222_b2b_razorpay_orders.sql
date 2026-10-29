-- 222: Razorpay Checkout for wholesale (B2B) purchases.
-- One Razorpay order can pay the unpaid orders of several requirements at once (a multi-seller cart),
-- so the order keeps the list of requirements it covers. Verified payments become escrow exactly like a wallet payment
-- (b2b_payments.method = 'RAZORPAY', reference = the Razorpay payment id).
CREATE TABLE IF NOT EXISTS b2b_razorpay_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id           UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  razorpay_order_id   VARCHAR(64) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(64),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  requirement_ids     UUID[] NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_b2b_rzp_orders_vendor ON b2b_razorpay_orders (vendor_id, status, created_at DESC);
