-- Sell-your-phone: Razorpay Checkout for the buyer's funding, automatic refunds, and RazorpayX payouts to the seller.
CREATE TABLE IF NOT EXISTS sell_razorpay_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES sell_requests(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  razorpay_order_id VARCHAR(64) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(64),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED', 'REFUNDED')),
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sell_rzp_orders_req ON sell_razorpay_orders (request_id, created_at);

-- Provider id of the money movement: Razorpay payment id (funding), refund id (refund), payout id (RazorpayX).
ALTER TABLE sell_payments ADD COLUMN IF NOT EXISTS provider_ref VARCHAR(80);
CREATE INDEX IF NOT EXISTS idx_sell_payments_provider ON sell_payments (provider_ref) WHERE provider_ref IS NOT NULL;
