-- 084_users_last_active_at.sql
--
-- Tracks when a user last made an authenticated request, so the admin
-- dashboard's "Active" customer count can be a real daily-active figure
-- instead of the previous client-side proxy (accounts not currently
-- blocked, computed only over whatever page of the list happened to be
-- loaded). Stamped by the `authenticate` preHandler on every request,
-- throttled there to avoid writing on every single call.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_last_active_at
  ON users(last_active_at) WHERE role = 'CUSTOMER';
