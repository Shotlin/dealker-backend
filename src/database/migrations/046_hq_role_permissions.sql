-- 046_hq_role_permissions.sql
-- Multi-vendor: seed the canonical HQ_Role → Permission_String mappings into
-- the existing `roles` table (migration 028). Together with the canonical
-- 37-string vocabulary defined by R17 AC#1, these rows are the database
-- source of truth that the runtime RBAC layer reads when computing the
-- effective permission set for HQ_Users (R17 AC#3, design §4.1):
--
--     effectivePermissions(request) =
--       if request.user.platform_role IS NOT NULL then
--         HQ_ROLE_PERMS[request.user.platform_role]
--       else ...
--
-- The five HQ_Role values seeded here mirror the CHECK vocabulary added by
-- migration 039 to `users.platform_role` (SUPER_ADMIN, ADMIN, HQ_MANAGER,
-- HQ_FINANCE, HQ_SUPPORT) so that every legal `users.platform_role` value
-- has a corresponding row in `roles` whose `permissions` JSONB array
-- enumerates the exact permission set the dashboard backend grants that
-- role. The mapping is derived **verbatim** from the source-of-truth table
-- in design §4.2 — any drift between this migration and that table is a
-- bug and must be reconciled by editing both in lockstep with
-- `src/utils/permissions.js#HQ_ROLE_PERMISSIONS` (design §4.2 closing
-- paragraph).
--
-- Per-role permission set (each ✓ cell in design §4.2 → one element below):
--
--   * SUPER_ADMIN — every Permission_String in the canonical 37-value
--                   vocabulary (R17 AC#1). Satisfies R16 AC#3:
--                   "unrestricted access to every endpoint and every
--                   Shop". Listed in alphabetical order to match the
--                   JSONB ordering produced by `jsonb_agg(token ORDER BY
--                   token)` elsewhere in the migration suite (e.g.
--                   migration 038) and to keep diffs reviewable.
--
--   * ADMIN       — identical to SUPER_ADMIN per the §4.2 source-of-truth
--                   table (every row has ✓ for ADMIN). Satisfies
--                   R16 AC#4 by granting view/manage on every shop-
--                   scoped resource plus the global reports/finance/
--                   audit_logs surfaces. The R16 AC#4 carve-out
--                   (ADMIN SHALL NOT create/update/delete a SUPER_ADMIN
--                   HQ_User) is enforced at the route layer in the HQ
--                   user-management module — it is *not* expressible
--                   in this static permission map because it gates an
--                   actor-vs-target relationship rather than a static
--                   capability.
--
--   * HQ_MANAGER  — operations-focused subset (R16 AC#5, §4.2): the full
--                   shops/staff/products/orders/coupons/reports/riders
--                   "manage" surface MINUS finance and HQ-user
--                   management. Specifically excludes: shops.create,
--                   shops.delete, shop_staff.delete, shop_products.delete,
--                   shop_orders.refund, shop_transactions.*,
--                   shop_financials.*, shop_coupons.delete,
--                   riders.approve, finance.global_view, audit_logs.view.
--                   Total: 23 strings.
--
--   * HQ_FINANCE  — finance-only subset (R16 AC#6, §4.2): view-only on
--                   shops + read/export on transactions/financials +
--                   refund + mark_paid + global reports + global
--                   finance + audit_logs.view. Excludes every
--                   product/staff/coupon mutation and every order
--                   mutation other than refund. Total: 13 strings.
--
--   * HQ_SUPPORT  — support-only subset (R16 AC#7, §4.2): view on
--                   shops/staff/products/orders/coupons/reports +
--                   order status/assign_rider/cancel + riders
--                   view/assign. Excludes every finance, audit, and
--                   global-reports surface and every refund / payout /
--                   approval action. Total: 11 strings.
--
-- Conflict resolution and idempotency (R17 AC#3, task 1.8):
--   * Each row is inserted with `ON CONFLICT (name) DO NOTHING` against
--     the unique index `idx_roles_name` (migration 028). Re-running this
--     migration is therefore a no-op once the rows exist. The
--     DO NOTHING semantics — chosen deliberately per task 1.8 — mean
--     that an operator who has hand-edited a row's `permissions`
--     post-migration will *not* have their edits clobbered on a
--     subsequent migration run. Any desired upgrade to the canonical
--     mapping must be shipped as a follow-up migration that explicitly
--     UPDATEs the row (mirroring the pattern used by migration 038 for
--     the legacy "Super Admin" role).
--
--   * The five `name` values used here (SUPER_ADMIN, ADMIN, HQ_MANAGER,
--     HQ_FINANCE, HQ_SUPPORT) are deliberately distinct from the legacy
--     display-name rows seeded by migration 028 ("Super Admin",
--     "Manager", "Support Agent", "Viewer") and the
--     dashboard-RBAC-token rows extended by migration 038. This keeps
--     the two RBAC universes (legacy display-name roles + new HQ_Role
--     map) co-resident in the same table without conflicting on the
--     `name` unique index.
--
-- Append-only-style emission contract:
--   * This migration only INSERTs; it never UPDATEs or DELETEs an
--     existing row. The `description` column is set on insert so that
--     `\d+ roles` and the team-management UI both render meaningful
--     text. The `is_system=true` flag matches the convention from
--     migration 028 — the dashboard team module guards system roles
--     against deletion / rename in the UI layer.
--
-- Requirements: R16.3, R16.4, R16.5, R16.6, R16.7, R17.3
-- Design:       §4.2 of .kiro/specs/multi-vendor-system/design.md

-- ═══════════════════════════════════════════════════════════════
-- SUPER_ADMIN — all 37 canonical Permission_Strings (R16 AC#3, §4.2)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('SUPER_ADMIN',
   'HQ platform role with unrestricted access to every endpoint and every Shop. Source of truth: design §4.2.',
   true,
   '[
     "audit_logs.view",
     "finance.global_view",
     "reports.global_view",
     "riders.approve",
     "riders.assign",
     "riders.view",
     "shop_coupons.create",
     "shop_coupons.delete",
     "shop_coupons.update",
     "shop_coupons.view",
     "shop_financials.export",
     "shop_financials.mark_paid",
     "shop_financials.view",
     "shop_orders.assign_rider",
     "shop_orders.cancel",
     "shop_orders.export",
     "shop_orders.refund",
     "shop_orders.update_status",
     "shop_orders.view",
     "shop_products.approve",
     "shop_products.bulk_update",
     "shop_products.create",
     "shop_products.delete",
     "shop_products.update",
     "shop_products.view",
     "shop_reports.view",
     "shop_staff.create",
     "shop_staff.delete",
     "shop_staff.reset_password",
     "shop_staff.update",
     "shop_staff.view",
     "shop_transactions.export",
     "shop_transactions.view",
     "shops.create",
     "shops.delete",
     "shops.update",
     "shops.view"
   ]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- ADMIN — identical permission set to SUPER_ADMIN per §4.2 (R16 AC#4).
-- The R16 AC#4 carve-out forbidding ADMIN from CRUDing a SUPER_ADMIN
-- HQ_User is enforced at the HQ user-management route layer, not via a
-- static permission map.
-- ═══════════════════════════════════════════════════════════════
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('ADMIN',
   'HQ platform role with full operational and financial access. Cannot create, update, or delete SUPER_ADMIN HQ_Users (enforced at route layer per R16 AC#4). Source of truth: design §4.2.',
   true,
   '[
     "audit_logs.view",
     "finance.global_view",
     "reports.global_view",
     "riders.approve",
     "riders.assign",
     "riders.view",
     "shop_coupons.create",
     "shop_coupons.delete",
     "shop_coupons.update",
     "shop_coupons.view",
     "shop_financials.export",
     "shop_financials.mark_paid",
     "shop_financials.view",
     "shop_orders.assign_rider",
     "shop_orders.cancel",
     "shop_orders.export",
     "shop_orders.refund",
     "shop_orders.update_status",
     "shop_orders.view",
     "shop_products.approve",
     "shop_products.bulk_update",
     "shop_products.create",
     "shop_products.delete",
     "shop_products.update",
     "shop_products.view",
     "shop_reports.view",
     "shop_staff.create",
     "shop_staff.delete",
     "shop_staff.reset_password",
     "shop_staff.update",
     "shop_staff.view",
     "shop_transactions.export",
     "shop_transactions.view",
     "shops.create",
     "shops.delete",
     "shops.update",
     "shops.view"
   ]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- HQ_MANAGER — operations subset (R16 AC#5, §4.2). 23 strings.
-- Excludes: shops.create, shops.delete, shop_staff.delete,
-- shop_products.delete, shop_orders.refund, shop_transactions.*,
-- shop_financials.*, shop_coupons.delete, riders.approve,
-- finance.global_view, audit_logs.view.
-- ═══════════════════════════════════════════════════════════════
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('HQ_MANAGER',
   'HQ platform role with operations-wide access (shops, staff, products, orders, coupons, reports, riders) but no global finance, audit, or HQ-user-management access. Source of truth: design §4.2.',
   true,
   '[
     "reports.global_view",
     "riders.assign",
     "riders.view",
     "shop_coupons.create",
     "shop_coupons.update",
     "shop_coupons.view",
     "shop_orders.assign_rider",
     "shop_orders.cancel",
     "shop_orders.export",
     "shop_orders.update_status",
     "shop_orders.view",
     "shop_products.approve",
     "shop_products.bulk_update",
     "shop_products.create",
     "shop_products.update",
     "shop_products.view",
     "shop_reports.view",
     "shop_staff.create",
     "shop_staff.reset_password",
     "shop_staff.update",
     "shop_staff.view",
     "shops.update",
     "shops.view"
   ]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- HQ_FINANCE — finance subset (R16 AC#6, §4.2). 13 strings.
-- View-only on shops + read/export on transactions/financials +
-- shop_orders.view/refund/export + shop_financials.mark_paid +
-- shop_reports.view + reports.global_view + finance.global_view +
-- audit_logs.view. Excludes every product/staff/coupon mutation and
-- every order mutation other than refund.
-- ═══════════════════════════════════════════════════════════════
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('HQ_FINANCE',
   'HQ platform role with finance-only access (transactions, financials, payouts, refunds, audit_logs, global finance/reports). No product, staff, coupon, or order mutation other than refund. Source of truth: design §4.2.',
   true,
   '[
     "audit_logs.view",
     "finance.global_view",
     "reports.global_view",
     "shop_financials.export",
     "shop_financials.mark_paid",
     "shop_financials.view",
     "shop_orders.export",
     "shop_orders.refund",
     "shop_orders.view",
     "shop_reports.view",
     "shop_transactions.export",
     "shop_transactions.view",
     "shops.view"
   ]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- HQ_SUPPORT — support subset (R16 AC#7, §4.2). 11 strings.
-- View on shops/staff/products/orders/coupons/reports +
-- shop_orders.update_status/assign_rider/cancel + riders.view/assign.
-- Excludes every finance, audit, global-reports surface and every
-- refund / payout / approval action.
-- ═══════════════════════════════════════════════════════════════
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('HQ_SUPPORT',
   'HQ platform role with support-only access (view shops/staff/products/orders/coupons/reports + non-financial order mutations + rider view/assign). No financial or audit access. Source of truth: design §4.2.',
   true,
   '[
     "riders.assign",
     "riders.view",
     "shop_coupons.view",
     "shop_orders.assign_rider",
     "shop_orders.cancel",
     "shop_orders.update_status",
     "shop_orders.view",
     "shop_products.view",
     "shop_reports.view",
     "shop_staff.view",
     "shops.view"
   ]'::jsonb)
ON CONFLICT (name) DO NOTHING;
