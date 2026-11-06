-- 227_subscription_purchases.sql
-- Vendors buy / renew their own subscription plan online (Razorpay). One row per checkout attempt;
-- a PAID row is what activated the plan, so the payment trail is auditable. Additive and idempotent.

CREATE TABLE IF NOT EXISTS subscription_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('PAID', 'PREMIUM', 'UNLIMITED')),
  cycle TEXT NOT NULL CHECK (cycle IN ('MONTHLY', 'YEARLY')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_subscription_purchases_vendor ON subscription_purchases (vendor_id, created_at DESC);
