-- 029_shops.sql
-- Create shops table for multi-vendor system
-- Supports shop CRUD, service area management, financial tracking

-- ═══════════════════════════════════════════════════════════════
-- 1. SHOPS TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shops (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identity
  name                  VARCHAR(200) NOT NULL,
  slug                  VARCHAR(250) UNIQUE NOT NULL,
  branch_code           VARCHAR(20) UNIQUE NOT NULL,
  description           TEXT,
  logo_url              TEXT,
  banner_url            TEXT,

  -- Contact
  phone                 VARCHAR(15),
  email                 VARCHAR(255),

  -- Address
  address_line1         VARCHAR(255) NOT NULL,
  address_line2         VARCHAR(255),
  city                  VARCHAR(100) NOT NULL,
  state                 VARCHAR(100) NOT NULL,
  pincode               VARCHAR(10) NOT NULL,

  -- Location
  lat                   DECIMAL(10,8) NOT NULL,
  lng                   DECIMAL(11,8) NOT NULL,

  -- Service Area
  serviceable_pincodes  TEXT[] NOT NULL DEFAULT '{}',
  delivery_radius_km    DECIMAL(5,2) DEFAULT 5.00
                        CONSTRAINT chk_shops_delivery_radius CHECK (delivery_radius_km >= 0.50 AND delivery_radius_km <= 100.00),

  -- Status
  is_active             BOOLEAN DEFAULT true,
  is_verified           BOOLEAN DEFAULT false,

  -- Operations
  operating_hours       JSONB DEFAULT '{}'::jsonb,

  -- Financials
  commission_rate       DECIMAL(5,2) DEFAULT 10.00
                        CONSTRAINT chk_shops_commission_rate CHECK (commission_rate >= 0.00 AND commission_rate <= 100.00),

  -- Bank Details
  bank_account_number   VARCHAR(20),
  bank_ifsc             VARCHAR(15),
  bank_name             VARCHAR(100),
  bank_holder_name      VARCHAR(100),

  -- Tax
  gst_number            VARCHAR(20),
  pan_number            VARCHAR(15),

  -- Aggregates
  total_orders          INTEGER DEFAULT 0,
  total_revenue         DECIMAL(12,2) DEFAULT 0,

  -- Ownership
  created_by            UUID REFERENCES users(id),

  -- Soft Delete
  deleted_at            TIMESTAMPTZ NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Partial index for active shops (excludes soft-deleted)
CREATE INDEX IF NOT EXISTS idx_shops_is_active
  ON shops (is_active)
  WHERE deleted_at IS NULL;

-- GIN index for pincode array lookups
CREATE INDEX IF NOT EXISTS idx_shops_serviceable_pincodes
  ON shops USING GIN (serviceable_pincodes);

-- Geolocation index for proximity queries
CREATE INDEX IF NOT EXISTS idx_shops_lat_lng
  ON shops (lat, lng);

-- City + active status for filtered listing
CREATE INDEX IF NOT EXISTS idx_shops_city_active
  ON shops (city, is_active);

-- Branch code lookup (unique constraint already creates index, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_shops_branch_code
  ON shops (branch_code);

-- Slug lookup (unique constraint already creates index, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_shops_slug
  ON shops (slug);

-- FK index on created_by
CREATE INDEX IF NOT EXISTS idx_shops_created_by
  ON shops (created_by);
