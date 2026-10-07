-- 013_delivery_assignments.sql
-- Delivery assignment tracking + delivery OTP + rider online/offline

-- Delivery assignments — links orders to riders with status tracking
CREATE TABLE IF NOT EXISTS delivery_assignments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  rider_id        UUID REFERENCES users(id) NOT NULL,
  status          VARCHAR(30) DEFAULT 'ASSIGNED'
                    CHECK (status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED')),
  assigned_at     TIMESTAMPTZ DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ,
  picked_up_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  delivery_otp    VARCHAR(6),
  proof_photo_url TEXT,
  distance_km     DECIMAL(8,2),
  earnings        DECIMAL(10,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_da_order    ON delivery_assignments(order_id);
CREATE INDEX IF NOT EXISTS idx_da_rider    ON delivery_assignments(rider_id, status);
CREATE INDEX IF NOT EXISTS idx_da_status   ON delivery_assignments(status) WHERE status NOT IN ('DELIVERED', 'CANCELLED');

-- Add delivery_partner_id to orders if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'delivery_partner_id'
  ) THEN
    ALTER TABLE orders ADD COLUMN delivery_partner_id UUID REFERENCES users(id);
    CREATE INDEX idx_orders_rider ON orders(delivery_partner_id);
  END IF;
END $$;

-- Add proof_photo_url to orders if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'proof_photo_url'
  ) THEN
    ALTER TABLE orders ADD COLUMN proof_photo_url TEXT;
  END IF;
END $$;

-- Add notification_preferences JSONB to users if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'notification_preferences'
  ) THEN
    ALTER TABLE users ADD COLUMN notification_preferences JSONB DEFAULT '{}';
  END IF;
END $$;
