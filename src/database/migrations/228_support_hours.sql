-- 228_support_hours.sql
-- Support opening hours shown in the vendor app's Help & Support (edit in Dashboard → Settings → Store Info).
-- Phone and email already live in app_settings (support_phone / support_email). Additive and idempotent.

INSERT INTO app_settings (key, value, description) VALUES
  ('support_hours', '"Mon–Sat, 9:00 AM – 7:00 PM IST"', 'Support opening hours shown in the apps')
ON CONFLICT (key) DO NOTHING;
