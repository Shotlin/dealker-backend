-- Migration 077: track the store's last-known effective open/closed state
-- so a periodic worker can detect when WEEKLY_SCHEDULE crosses a boundary
-- (e.g. closing time passes with no admin action) and push a live update +
-- audit-log entry. Previously isOpen() was only ever evaluated reactively
-- per-request — a schedule-driven transition never reached already-open
-- customer app sessions until they happened to refetch, and never showed
-- up anywhere in the admin's activity history.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'store_status' AND column_name = 'last_known_is_open'
  ) THEN
    ALTER TABLE store_status ADD COLUMN last_known_is_open BOOLEAN;
  END IF;
END $$;
