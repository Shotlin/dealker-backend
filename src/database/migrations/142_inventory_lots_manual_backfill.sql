-- Lets an admin/shop-staff backfill a vendor batch record for stock that
-- was never received through the Vendor Procurement pipeline (§7.5.1) —
-- e.g. stock that pre-dates the procurement system, or was typed in by
-- hand before a vendor relationship was formalized. A manual lot carries
-- its own vendor name / quality-video URL directly (there is no real
-- procurement_receipt_item/supply_order/vendor chain to join through),
-- so it never gets confused with a real vendor-procurement lot.
ALTER TABLE inventory_lots
  ADD COLUMN IF NOT EXISTS is_manual_entry BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_vendor_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS manual_video_url TEXT,
  ADD COLUMN IF NOT EXISTS manual_notes TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
