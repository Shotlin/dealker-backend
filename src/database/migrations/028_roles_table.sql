-- 028_roles_table.sql
-- Create roles table and role_id column for RBAC system
-- This was missing — the team module queries this table but it was never created

-- ═══════════════════════════════════════════════════════════════
-- 1. ROLES TABLE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(64) NOT NULL,
  description TEXT DEFAULT '',
  permissions JSONB DEFAULT '[]'::jsonb,
  is_system   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(name);

-- ═══════════════════════════════════════════════════════════════
-- 2. ADD role_id COLUMN TO USERS TABLE
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);

-- ═══════════════════════════════════════════════════════════════
-- 3. SEED DEFAULT SYSTEM ROLES
-- ═══════════════════════════════════════════════════════════════
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('Super Admin', 'Full access to all features', true,
   '["orders.view","orders.manage","orders.delete","products.view","products.manage","products.delete","categories.view","categories.manage","customers.view","customers.manage","riders.view","riders.manage","analytics.view","analytics.export","coupons.view","coupons.manage","reviews.view","reviews.moderate","wallet.view","wallet.manage","settings.view","settings.manage","team.view","team.manage","banners.view","banners.manage","notifications.view","notifications.manage"]'::jsonb),
  ('Manager', 'Manage orders, products, and customers', false,
   '["orders.view","orders.manage","products.view","products.manage","categories.view","categories.manage","customers.view","customers.manage","riders.view","analytics.view","coupons.view","coupons.manage","reviews.view","reviews.moderate","banners.view","banners.manage","notifications.view"]'::jsonb),
  ('Support Agent', 'View orders and handle customer queries', false,
   '["orders.view","orders.manage","products.view","customers.view","customers.manage","reviews.view","reviews.moderate","notifications.view"]'::jsonb),
  ('Viewer', 'Read-only access to dashboard data', false,
   '["orders.view","products.view","categories.view","customers.view","riders.view","analytics.view","coupons.view","reviews.view","wallet.view","banners.view","notifications.view"]'::jsonb)
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 4. ASSIGN EXISTING ADMINS TO 'Super Admin' ROLE
-- ═══════════════════════════════════════════════════════════════
UPDATE users
SET role_id = (SELECT id FROM roles WHERE name = 'Super Admin' AND is_system = true LIMIT 1)
WHERE role = 'ADMIN' AND role_id IS NULL;
