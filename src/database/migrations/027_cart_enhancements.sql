-- 027_cart_enhancements.sql
-- Cart UI Revamp: fees, tips, delivery instructions, payment offers

-- ─── 1. Orders Table Enhancements ──────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS handling_fee DECIMAL(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS late_night_fee DECIMAL(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip_amount DECIMAL(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_instructions TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS savings_total DECIMAL(10,2) DEFAULT 0;

-- ─── 2. Fee Configuration ──────────────────────────
CREATE TABLE IF NOT EXISTS fee_config (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fee_type          VARCHAR(50) UNIQUE NOT NULL,
  amount            DECIMAL(10,2) NOT NULL DEFAULT 0,
  free_threshold    DECIMAL(10,2) DEFAULT NULL,
  is_active         BOOLEAN DEFAULT true,
  description       TEXT,
  start_hour        INTEGER DEFAULT NULL,
  end_hour          INTEGER DEFAULT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO fee_config (fee_type, amount, free_threshold, is_active, description, start_hour, end_hour)
VALUES
  ('delivery_fee', 30.00, 499.00, true, 'Standard delivery fee', NULL, NULL),
  ('handling_fee', 10.00, NULL, true, 'Order handling & packaging fee', NULL, NULL),
  ('late_night_fee', 35.00, NULL, true, 'Surcharge for orders 11PM-6AM', 23, 6),
  ('delivery_estimate_minutes', 6.00, NULL, true, 'Default estimated delivery time in minutes', NULL, NULL)
ON CONFLICT (fee_type) DO NOTHING;

-- ─── 3. Tip Presets ────────────────────────────────
CREATE TABLE IF NOT EXISTS tip_presets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  amount      DECIMAL(10,2) NOT NULL,
  emoji       VARCHAR(10),
  sort_order  INTEGER,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO tip_presets (id, amount, emoji, sort_order, is_active)
VALUES
  ('7d04f2d5-5ee4-43d1-8ec2-b0dcf4b7d101', 10.00, '🍵', 1, true),
  ('8b7cb59d-3b8a-4922-93dc-a41af7d7e6d4', 35.00, '🔥', 2, true),
  ('fca4e1ca-7902-4b4e-bb23-7239acb0a2f5', 50.00, '🤩', 3, true)
ON CONFLICT (id) DO NOTHING;

-- ─── 4. Payment Offers ─────────────────────────────
CREATE TABLE IF NOT EXISTS payment_offers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title             VARCHAR(255) NOT NULL,
  description       TEXT,
  provider          VARCHAR(50) NOT NULL,
  icon_url          TEXT,
  cashback_amount   DECIMAL(10,2) NOT NULL DEFAULT 0,
  cashback_percent  DECIMAL(5,2) DEFAULT NULL,
  min_order_amount  DECIMAL(10,2) DEFAULT 0,
  max_cashback      DECIMAL(10,2) DEFAULT NULL,
  lock_threshold    DECIMAL(10,2) DEFAULT NULL,
  is_active         BOOLEAN DEFAULT true,
  valid_from        TIMESTAMPTZ DEFAULT NOW(),
  valid_until       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
