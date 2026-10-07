-- 162_marketplace_rbac_seed.sql
-- Marketplace roles. Permissions follow the canonical dotted vocabulary in
-- src/utils/permissions.js (this seed mirrors it; the code is authoritative
-- at boot via runPermissionAudit).

INSERT INTO roles (name, permissions, is_system)
VALUES
  ('Super Admin', to_jsonb(ARRAY['*'::text]), TRUE),
  ('Platform Admin', to_jsonb(ARRAY[
    'orders.view','orders.manage','seller_orders.view','seller_orders.manage',
    'vendors.view','vendors.approve','vendors.suspend','vendor_documents.view',
    'marketplace.listings.view','marketplace.listings.moderate',
    'products.view','products.manage','categories.view','categories.manage',
    'coupons.view','coupons.manage','cart_milestones.view','cart_milestones.manage',
    'loyalty.view','loyalty.manage','loyalty_settings.view','loyalty_settings.manage',
    'referrals.view','referrals.manage','referral_settings.manage',
    'wallet.view','wallet.manage','settlements.view','settlements.manage',
    'shipping.view','shipping.manage','shipping_providers.manage',
    'b2b_supply.view','b2b_supply.manage',
    'themes.view','themes.manage','banners.view','banners.manage',
    'customers.view','reviews.view','reviews.moderate',
    'audit_logs.view','reports.global_view','settings.manage'
  ]), TRUE),
  ('Catalog Manager', to_jsonb(ARRAY[
    'products.view','products.manage','categories.view','categories.manage',
    'marketplace.listings.view','marketplace.listings.moderate',
    'bulk_import.view','bulk_import.manage','orders.view'
  ]), TRUE),
  ('Marketing Manager', to_jsonb(ARRAY[
    'coupons.view','coupons.manage','cart_milestones.view','cart_milestones.manage',
    'loyalty.view','loyalty.manage','loyalty_settings.view','loyalty_settings.manage',
    'referrals.view','referrals.manage','referral_settings.manage',
    'banners.view','banners.manage','themes.view','themes.manage','reports.global_view'
  ]), TRUE),
  ('Finance Manager', to_jsonb(ARRAY[
    'settlements.view','settlements.manage','wallet.view','wallet.manage',
    'reports.global_view','audit_logs.view','refunds.view','refunds.manage'
  ]), TRUE),
  ('Support Agent', to_jsonb(ARRAY[
    'orders.view','orders.manage','refunds.view','returns.view','returns.manage',
    'customers.view','reviews.view'
  ]), TRUE),
  ('Vendor Owner', to_jsonb(ARRAY[
    'seller_orders.view','seller_orders.manage',
    'shop_products.view','shop_products.manage',
    'inventory.view','inventory.manage',
    'b2b_supply.view','b2b_supply.manage',
    'shipping.view','shipping.manage',
    'returns.view','returns.manage',
    'settlements.view','shop_financials.view',
    'bulk_import.view','bulk_import.manage',
    'shop_staff.view','shop_staff.manage',
    'vendor_profile.manage'
  ]), TRUE),
  ('Vendor Manager', to_jsonb(ARRAY[
    'seller_orders.view','seller_orders.manage',
    'shop_products.view','shop_products.manage',
    'inventory.view','inventory.manage',
    'shipping.view','returns.view','returns.manage','settlements.view','shop_financials.view'
  ]), TRUE),
  ('Vendor Catalog', to_jsonb(ARRAY[
    'shop_products.view','shop_products.manage','bulk_import.view','bulk_import.manage','inventory.view'
  ]), TRUE),
  ('Vendor Order Manager', to_jsonb(ARRAY[
    'seller_orders.view','seller_orders.manage','shipping.view','returns.view','returns.manage'
  ]), TRUE),
  ('Vendor Finance', to_jsonb(ARRAY[
    'settlements.view','shop_financials.view'
  ]), TRUE),
  ('Vendor Warehouse', to_jsonb(ARRAY[
    'seller_orders.view','seller_orders.manage','inventory.view','inventory.manage','shipping.view'
  ]), TRUE)
ON CONFLICT (name) DO UPDATE
  SET permissions = EXCLUDED.permissions, is_system = TRUE;

-- Vendor user roles (vendor_users.role from migration 095) keep their
-- values; the vendor-scope middleware maps them onto the permission sets
-- above by platform role.
