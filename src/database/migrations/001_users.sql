-- 001_users.sql
-- Extensions + Users table

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TYPE user_role AS ENUM ('CUSTOMER', 'DELIVERY', 'ADMIN');

CREATE TABLE IF NOT EXISTS users (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone                    VARCHAR(15) UNIQUE NOT NULL,
  email                    VARCHAR(255) UNIQUE,
  name                     VARCHAR(100),
  role                     user_role DEFAULT 'CUSTOMER',
  avatar_url               TEXT,
  birthday                 DATE,
  is_active                BOOLEAN DEFAULT true,
  fcm_token                TEXT,
  referral_code            VARCHAR(10) UNIQUE,
  referred_by              UUID REFERENCES users(id),
  loyalty_points           INTEGER DEFAULT 0,
  wallet_balance           DECIMAL(10,2) DEFAULT 0.00,
  notification_preferences JSONB DEFAULT '{"orderUpdates":true,"promotions":true,"newProducts":true,"deliveryUpdates":true,"priceDrops":true}',
  last_location            POINT,
  location_updated_at      TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
