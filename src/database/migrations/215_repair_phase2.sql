-- Repair marketplace phase 2: technician contact, customer ↔ shop chat, in-app (Razorpay) payments.
ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS technician_phone VARCHAR(20);

CREATE TABLE IF NOT EXISTS repair_messages (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('CUSTOMER', 'VENDOR')),
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repair_messages_req ON repair_messages (request_id, id);

CREATE TABLE IF NOT EXISTS repair_razorpay_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('ADVANCE', 'BALANCE')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repair_rzp_req ON repair_razorpay_orders (request_id, status);

-- Wallet debits for repair payments.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_tx_sub_type;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_tx_sub_type CHECK (
  sub_type IS NULL OR sub_type IN (
    'REFUND', 'BONUS', 'SCRATCH', 'CASHBACK', 'ORDER', 'TOPUP', 'AUCTION_FEE', 'AUCTION_REFUND', 'SELL_PAYOUT', 'VENDOR_TRANSFER', 'REPAIR')
);
