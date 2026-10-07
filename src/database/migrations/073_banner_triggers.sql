-- Migration 073: Banner trigger type — lets the admin mark a banner to show
-- only while the store is closed (e.g. a "We are closed" banner), driven by
-- the Phase 1 store-status evaluator. Every existing banner defaults to
-- 'ALWAYS', so current banner behavior is unchanged until an admin
-- explicitly creates a 'STORE_CLOSED' banner.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'banners' AND column_name = 'trigger_type'
  ) THEN
    ALTER TABLE banners ADD COLUMN trigger_type VARCHAR(20) NOT NULL DEFAULT 'ALWAYS';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_banners_trigger_type'
  ) THEN
    ALTER TABLE banners ADD CONSTRAINT chk_banners_trigger_type
      CHECK (trigger_type IN ('ALWAYS', 'STORE_CLOSED'));
  END IF;
END $$;
