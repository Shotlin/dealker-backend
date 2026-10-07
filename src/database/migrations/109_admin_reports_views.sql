-- Migration 109: Admin Reporting Views & Summary Read Models
-- Source of truth: Blueprint §06.10, Phase 11

-- 1. Vendor Summary View
CREATE OR REPLACE VIEW v_vendor_summary AS
SELECT
  COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active_vendors,
  COUNT(*) FILTER (WHERE status = 'PENDING_ONBOARDING') AS pending_onboarding,
  COUNT(*) FILTER (WHERE status = 'VERIFIED') AS verified_vendors,
  COUNT(*) FILTER (WHERE status = 'SUSPENDED') AS suspended_vendors,
  COUNT(*) AS total_vendors
FROM vendors;

-- 2. Catalogue Summary View
CREATE OR REPLACE VIEW v_catalogue_summary AS
SELECT
  (SELECT COUNT(*) FROM brands) AS total_brands,
  (SELECT COUNT(*) FROM product_proposals) AS total_proposals,
  (SELECT COUNT(*) FROM product_proposals WHERE status = 'PUBLISHED') AS published_proposals,
  (SELECT COUNT(*) FROM products) AS total_master_products;

-- 3. Procurement Summary View
CREATE OR REPLACE VIEW v_procurement_summary AS
SELECT
  COUNT(*) AS total_orders,
  COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_orders,
  COUNT(*) FILTER (WHERE status = 'RECEIVED') AS received_orders,
  COALESCE(SUM(total_cost), 0.00) AS total_procurement_value
FROM procurement_orders;

-- 4. Warehouse & Inventory Summary View
CREATE OR REPLACE VIEW v_inventory_summary AS
SELECT
  (SELECT COUNT(*) FROM warehouses) AS total_warehouses,
  (SELECT COUNT(*) FROM inventory_lots) AS total_lots,
  COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_lots), 0.00) AS total_quantity_on_hand,
  COALESCE((SELECT SUM(quantity_reserved) FROM inventory_lots), 0.00) AS total_quantity_reserved,
  COALESCE((SELECT SUM(quantity_available) FROM inventory_lots), 0.00) AS total_quantity_available;

-- 5. Order & Delivery Summary View
CREATE OR REPLACE VIEW v_order_delivery_summary AS
SELECT
  (SELECT COUNT(*) FROM orders) AS total_orders,
  (SELECT COUNT(*) FROM orders WHERE status = 'COMPLETED') AS completed_orders,
  (SELECT COUNT(*) FROM orders WHERE status = 'CANCELLED') AS cancelled_orders,
  COALESCE((SELECT SUM(total_payable) FROM orders WHERE status = 'COMPLETED'), 0.00) AS total_revenue,
  (SELECT COUNT(*) FROM riders WHERE is_active = true) AS active_riders,
  (SELECT COUNT(*) FROM delivery_assignments WHERE status = 'DELIVERED') AS completed_deliveries;
