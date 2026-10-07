-- 147_shop_staff_rider_permissions_backfill.sql
-- Defensive backfill for the 2026-09-28 shop-scoped Rider Management
-- fix (riders.routes.js): SHOP_ADMIN/SHOP_MANAGER already get
-- riders.view/riders.assign/riders.approve/riders.manage by default via
-- SHOP_SCOPED_PERMISSIONS in utils/permissions.js — but that default is
-- only ever applied at shop_staff row CREATION time (or an explicit
-- permission-set update), so an existing row created before these
-- canonical permission strings existed, or with a custom narrower
-- permissions array, would not have picked them up automatically.
-- This is a pure insurance UPDATE: additive (never removes anything),
-- idempotent (jsonb_agg(DISTINCT ...) — safe to re-run), and a no-op
-- for any row that already has the four strings.

UPDATE shop_staff
SET permissions = (
  SELECT jsonb_agg(DISTINCT elem)
  FROM jsonb_array_elements_text(
    COALESCE(permissions, '[]'::jsonb)
    || '["riders.view","riders.assign","riders.approve","riders.manage"]'::jsonb
  ) AS elem
),
    updated_at = NOW()
WHERE role IN ('SHOP_ADMIN', 'SHOP_MANAGER')
  AND deleted_at IS NULL
  AND NOT (
    COALESCE(permissions, '[]'::jsonb) @> '["riders.view","riders.assign","riders.approve","riders.manage"]'::jsonb
  );
