-- 010_riders.sql
-- Rider profiles + earnings tracking

CREATE TABLE IF NOT EXISTS rider_profiles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID REFERENCES users(id) UNIQUE NOT NULL,
  vehicle_type      VARCHAR(50),
  vehicle_number    VARCHAR(20),
  license_url       TEXT,
  aadhar_url        TEXT,
  is_approved       BOOLEAN DEFAULT false,
  is_online         BOOLEAN DEFAULT false,
  current_lat       DECIMAL(10,8),
  current_lng       DECIMAL(11,8),
  rating            DECIMAL(3,2) DEFAULT 0,
  total_deliveries  INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_user     ON rider_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_rider_approved ON rider_profiles(is_approved);
CREATE INDEX IF NOT EXISTS idx_rider_online   ON rider_profiles(is_online) WHERE is_online = true;

CREATE TABLE IF NOT EXISTS rider_earnings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id    UUID REFERENCES users(id) NOT NULL,
  order_id    UUID REFERENCES orders(id),
  amount      DECIMAL(10,2) NOT NULL,
  type        VARCHAR(50) DEFAULT 'delivery',
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_earnings_rider ON rider_earnings(rider_id, created_at DESC);
