-- Migration 075: Store Status closed banner — an admin-uploadable image
-- shown at the top of the mobile home screen (first row, above the promo
-- carousel) automatically whenever the store is closed (weekly schedule or
-- manual override), so admins can change the artwork without an app
-- release. Distinct from the general banners table's STORE_CLOSED
-- trigger_type (migration 073) — this is a single, dedicated image tied
-- directly to Store Hours settings, not part of the multi-banner carousel.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'store_status' AND column_name = 'closed_banner_image_url'
  ) THEN
    ALTER TABLE store_status ADD COLUMN closed_banner_image_url TEXT NULL;
  END IF;
END $$;
