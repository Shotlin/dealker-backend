-- Migration 074: Quick Delivery ETA — the admin-configurable delivery time
-- shown/promised when a customer opts into "Quick Delivery" (distinct from
-- the normal fee_settings.delivery_eta_minutes, which is the plain, always-
-- shown estimate). Defaults to 15 (faster than the typical 30-45 min normal
-- estimate) so it ships with a sensible value on day one.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fee_settings' AND column_name = 'quick_delivery_eta_minutes'
  ) THEN
    ALTER TABLE fee_settings ADD COLUMN quick_delivery_eta_minutes INTEGER NOT NULL DEFAULT 15;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_fs_quick_delivery_eta'
  ) THEN
    ALTER TABLE fee_settings ADD CONSTRAINT chk_fs_quick_delivery_eta
      CHECK (quick_delivery_eta_minutes >= 0 AND quick_delivery_eta_minutes <= 100000);
  END IF;
END $$;
