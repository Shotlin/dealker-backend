-- 039_users_platform_role_force_password.sql
-- Multi-vendor: extend `users` for HQ platform roles + first-login password
-- enforcement + admin-side blocking.
--
-- Adds three columns to `users` (idempotent — uses IF NOT EXISTS):
--   * platform_role         VARCHAR(20)  — HQ_Role for dashboard users.
--                                          NULL for customers / riders /
--                                          shop-staff-only operators.
--                                          CHECK-constrained vocabulary:
--                                          SUPER_ADMIN, ADMIN, HQ_MANAGER,
--                                          HQ_FINANCE, HQ_SUPPORT.
--   * force_password_change BOOLEAN      — gates all routes except `/me`,
--                                          `/change-password`, `/logout`
--                                          while true (R20 AC#7).
--   * is_blocked            BOOLEAN      — admin-side hard block; login is
--                                          rejected with USER_INACTIVE when
--                                          true (R29 AC#3, design §3.2.1).
--
-- Also adds two supporting indexes (per design §3.2.1):
--   * idx_users_platform_role  — fast HQ_Role lookups for RBAC fanout.
--   * idx_users_email_lower    — case-insensitive admin login lookup
--                                (R29 AC#3, dashboard `/admin/auth/login`).
--
-- Backfill: existing `role='ADMIN'` rows receive `platform_role='ADMIN'`.
-- SUPER_ADMIN must be promoted manually — design §3.2.1 explicitly
-- forbids auto-promotion during migration.
--
-- Idempotent: re-running this migration is a no-op. The CHECK constraint
-- is created inside a DO block guarded by pg_constraint lookup so the
-- second run does not raise `duplicate_object`.
--
-- Requirements: R16.1, R16.2, R20.6, R29.3
-- Design:       §3.2.1 of .kiro/specs/multi-vendor-system/design.md

ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_platform_role'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_users_platform_role
      CHECK (
        platform_role IS NULL
        OR platform_role IN ('SUPER_ADMIN','ADMIN','HQ_MANAGER','HQ_FINANCE','HQ_SUPPORT')
      );
  END IF;
END $$;

-- Backfill: legacy ADMINs become platform ADMINs. Idempotent via the
-- `platform_role IS NULL` guard — re-runs touch zero rows.
UPDATE users
   SET platform_role = 'ADMIN'
 WHERE role = 'ADMIN'
   AND platform_role IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_platform_role ON users(platform_role);
CREATE INDEX IF NOT EXISTS idx_users_email_lower   ON users (LOWER(email));
