-- 038_super_admin_permissions_multi_vendor.sql
-- Backfill the seeded "Super Admin" role with the new multi-vendor permission
-- tokens used by the dashboard's RBAC layer.
--
-- Migration 028 seeded the role with the legacy `view/manage` shape
-- (orders.view, orders.manage, ...). The new dashboard expects the
-- read/write/delete shape (shops.read, shops.write, shop-staff.*,
-- shop-products.*, shop-financials.read, shop-transactions.read, etc.).
-- Without this backfill, "Create shop" and every other shop-scoped CTA
-- stays hidden because useRouteRBAC.canWrite derives from the new tokens.
--
-- The token list mirrors bakaloo-dashboard/src/lib/permissions.ts
-- PermissionToken union (one source of truth).
--
-- Idempotent — re-running only adds tokens that are not already present
-- because we union the existing JSONB array with the desired set.

WITH desired(token) AS (
  VALUES
    -- shops
    ('shops.read'), ('shops.write'), ('shops.delete'),
    -- shop staff
    ('shop-staff.read'), ('shop-staff.write'), ('shop-staff.delete'),
    -- shop products (per-shop inventory)
    ('shop-products.read'), ('shop-products.write'), ('shop-products.delete'),
    -- read-only financial surfaces
    ('shop-financials.read'),
    ('shop-transactions.read'),
    -- existing surfaces in the new read/write/delete shape
    ('orders.read'), ('orders.write'), ('orders.delete'),
    ('products.read'), ('products.write'), ('products.delete'),
    ('customers.read'), ('customers.write'),
    ('activity-log.read')
),
merged AS (
  -- Existing tokens currently on the Super Admin role.
  SELECT existing.token
  FROM roles r,
       LATERAL jsonb_array_elements_text(r.permissions) AS existing(token)
  WHERE r.name = 'Super Admin' AND r.is_system = true

  UNION

  -- All desired multi-vendor tokens.
  SELECT token FROM desired
)
UPDATE roles
SET    permissions = (SELECT jsonb_agg(token ORDER BY token) FROM merged),
       updated_at  = NOW()
WHERE  name = 'Super Admin' AND is_system = true;
