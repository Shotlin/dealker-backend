-- 078_gst_rate_setting.sql
-- Seed a single admin-configurable GST rate (percentage) used by the
-- Analytics GST Breakdown card, which previously hardcoded gst_rate/
-- gst_amount to 0 (no rate was modeled anywhere in the schema). ON
-- CONFLICT DO NOTHING so any value an admin already saved is preserved.
--
-- Single flat rate, not per-product — matches the confirmed scope (a
-- configurable rate, not a full multi-rate tax-slab system).

INSERT INTO app_settings (key, value, description) VALUES
  ('gst_rate', '5', 'GST rate (%) applied to the Analytics GST Breakdown report; order_items.total is treated as GST-inclusive')
ON CONFLICT (key) DO NOTHING;
