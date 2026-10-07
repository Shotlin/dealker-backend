-- 079_gst_tax_settings.sql
-- Real, admin-configurable GST charged per order (exclusive — added on top
-- of subtotal + delivery + other fees), computed by TotalsEngine and
-- persisted to orders.tax_amount. Defaults to gst_enabled=false so this
-- ships with zero behavior change until an admin explicitly turns it on
-- from Settings -> Fees.
--
-- Previously the only "GST rate" in the system was a report-only
-- app_settings.gst_rate key (migration 078) that never actually charged
-- anyone — this is the real, billing-affecting rate. Once gst_enabled is
-- turned on, the Analytics GST Breakdown switches to summing the real
-- orders.tax_amount instead of back-calculating from item totals.

ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS gst_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00
  CONSTRAINT chk_fs_gst_rate CHECK (gst_rate >= 0 AND gst_rate <= 100);
ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS gst_label VARCHAR(60) NOT NULL DEFAULT 'GST';
