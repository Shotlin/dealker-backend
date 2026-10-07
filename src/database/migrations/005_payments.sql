-- 005_payments.sql
-- Payment records linked to orders

CREATE TABLE IF NOT EXISTS payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id              UUID REFERENCES orders(id) NOT NULL,
  user_id               UUID REFERENCES users(id) NOT NULL,
  razorpay_order_id     VARCHAR(100),
  razorpay_payment_id   VARCHAR(100),
  razorpay_signature    VARCHAR(255),
  amount                DECIMAL(10,2) NOT NULL,
  currency              VARCHAR(3) DEFAULT 'INR',
  status                VARCHAR(20) DEFAULT 'PENDING',
  method                VARCHAR(50),
  refund_id             VARCHAR(100),
  refund_amount         DECIMAL(10,2),
  refund_status         VARCHAR(20),
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order        ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_user         ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_razorpay     ON payments(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status       ON payments(status);
