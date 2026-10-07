-- 052_payment_expiry_and_cleanup.sql
-- Add expires_at to payments for 15-minute pending payment expiry
-- Add PAYMENT_EXPIRED to payment_status values

-- Add expires_at column to payments table (15-min window for online payments)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Index for the cleanup worker to find expired pending payments efficiently
CREATE INDEX IF NOT EXISTS idx_payments_pending_expired
  ON payments(expires_at)
  WHERE status = 'PENDING' AND expires_at IS NOT NULL;

-- Add PAYMENT_EXPIRED as a valid payment_status value on orders
-- (VARCHAR not enum, so just document valid values in a CHECK constraint)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'payment_expires_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN payment_expires_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_pending_payment_expiry
  ON orders(payment_expires_at)
  WHERE payment_status = 'PENDING' AND payment_method = 'ONLINE'
    AND payment_expires_at IS NOT NULL;
