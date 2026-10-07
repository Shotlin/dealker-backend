-- 008_addresses.sql
-- User saved delivery addresses

CREATE TABLE IF NOT EXISTS addresses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  label         VARCHAR(50) DEFAULT 'Home',
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255),
  landmark      VARCHAR(255),
  city          VARCHAR(100) NOT NULL,
  state         VARCHAR(100),
  pincode       VARCHAR(10) NOT NULL,
  lat           DECIMAL(10,8),
  lng           DECIMAL(11,8),
  is_default    BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addresses_user     ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_addresses_default  ON addresses(user_id, is_default) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS idx_addresses_pincode  ON addresses(pincode);
