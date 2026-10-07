-- 030_shop_staff.sql
-- Create shop_staff table for multi-vendor role-based access
-- Supports staff assignment, role management, granular permissions

-- ═══════════════════════════════════════════════════════════════
-- 1. SHOP_STAFF TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_staff (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Relationships
  user_id               UUID NOT NULL REFERENCES users(id),
  shop_id               UUID NOT NULL REFERENCES shops(id),

  -- Role & Permissions
  role                  VARCHAR(30) NOT NULL
                        CONSTRAINT chk_shop_staff_role CHECK (role IN ('SHOP_ADMIN', 'SHOP_MANAGER', 'SHOP_STAFF', 'SHOP_VIEWER')),
  permissions           JSONB DEFAULT '[]'::jsonb,

  -- Status
  is_active             BOOLEAN DEFAULT true,

  -- Invitation tracking
  invited_by            UUID REFERENCES users(id),

  -- Soft Delete
  deleted_at            TIMESTAMPTZ NULL,

  -- Timestamps
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT uq_shop_staff_user_shop UNIQUE (user_id, shop_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- User lookup (find all shops a user belongs to)
CREATE INDEX IF NOT EXISTS idx_shop_staff_user_id
  ON shop_staff (user_id);

-- Shop + active status (list active staff for a shop)
CREATE INDEX IF NOT EXISTS idx_shop_staff_shop_active
  ON shop_staff (shop_id, is_active);

-- Shop + role (filter staff by role within a shop)
CREATE INDEX IF NOT EXISTS idx_shop_staff_shop_role
  ON shop_staff (shop_id, role);
