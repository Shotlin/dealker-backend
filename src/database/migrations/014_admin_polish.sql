-- 014_admin_polish.sql
-- Week 6: Admin & Polish — app_settings, user blocking, index audit

-- ─── APP SETTINGS TABLE ──────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default settings
INSERT INTO app_settings (key, value, description) VALUES
  ('delivery_fee',       '25',          'Flat delivery fee in INR'),
  ('free_delivery_above','499',         'Free delivery threshold in INR'),
  ('platform_fee',       '5',           'Platform fee per order in INR'),
  ('delivery_radius_km', '10',          'Max delivery radius in KM'),
  ('express_delivery_min','30',         'Express delivery time in minutes'),
  ('cod_max_amount',     '2000',        'Max COD order amount in INR'),
  ('min_order_amount',   '99',          'Minimum order amount in INR'),
  ('app_maintenance',    'false',       'App maintenance mode'),
  ('app_version',        '"1.0.0"',     'Current app version'),
  ('support_phone',      '"+919775845587"', 'Customer support phone'),
  ('support_email',      '"support@groceryapp.com"', 'Customer support email')
ON CONFLICT (key) DO NOTHING;

-- ─── USER BLOCKING ──────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS block_reason TEXT;

-- ─── INDEX AUDIT ─────────────────────────────────────
-- Orders — frequently filtered by status, date, payment
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders (user_id, status);

-- Reviews — frequently filtered by product
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews (product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews (user_id);

-- Wishlist — filtered by user
CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON wishlist (user_id);

-- Delivery assignments — filtered by rider + status
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_rider_status ON delivery_assignments (rider_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_order_id ON delivery_assignments (order_id);

-- Rider profiles — online/approved filtering
CREATE INDEX IF NOT EXISTS idx_rider_profiles_online ON rider_profiles (is_online) WHERE is_online = true;
CREATE INDEX IF NOT EXISTS idx_rider_profiles_approved ON rider_profiles (is_approved);

-- Products — search + filter
CREATE INDEX IF NOT EXISTS idx_products_category_active ON products (category_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_products_total_sold ON products (total_sold DESC);

-- Notifications — user + unread
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, is_read) WHERE is_read = false;

-- FCM tokens — user lookup
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id ON fcm_tokens (user_id);

-- Addresses — user lookup
CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses (user_id);

-- Payments — order lookup
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);

-- Coupons — code lookup
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons (code);
CREATE INDEX IF NOT EXISTS idx_coupon_usages_user ON coupon_usages (user_id);
