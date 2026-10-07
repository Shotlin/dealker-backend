-- 015_admin_dashboard.sql
-- Admin Dashboard Additions: 9 new tables + column extensions
-- Tables: order_status_history, product_variants, product_views,
--         rider_payouts, rider_documents, notification_templates,
--         notification_campaigns, banners, admin_activity_log

-- ═══════════════════════════════════════════════════════════════
-- 1. ORDER STATUS HISTORY (timeline in order detail drawer)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS order_status_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  from_status VARCHAR(30),
  to_status   VARCHAR(30) NOT NULL,
  changed_by  UUID REFERENCES users(id),
  note        TEXT,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id, changed_at ASC);
CREATE INDEX IF NOT EXISTS idx_osh_admin ON order_status_history(changed_by);

-- ═══════════════════════════════════════════════════════════════
-- 2. PRODUCT VARIANTS (size/weight/color variants)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_variants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id    UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  name          VARCHAR(100) NOT NULL,
  sku           VARCHAR(100) UNIQUE,
  price         DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  sale_price    DECIMAL(10,2) CHECK (sale_price >= 0),
  stock         INTEGER DEFAULT 0 CHECK (stock >= 0),
  image_url     TEXT,
  display_order INTEGER DEFAULT 0,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pv_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_pv_sku     ON product_variants(sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pv_active  ON product_variants(product_id, is_active) WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════════
-- 3. PRODUCT VIEWS (analytics — "most viewed but not bought")
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_views (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id  UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  source      VARCHAR(50),
  viewed_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pviews_product ON product_views(product_id);
CREATE INDEX IF NOT EXISTS idx_pviews_date    ON product_views(viewed_at);
CREATE INDEX IF NOT EXISTS idx_pviews_user    ON product_views(user_id) WHERE user_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- 4. RIDER PAYOUTS (bank transfer history)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rider_payouts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id      UUID REFERENCES users(id) NOT NULL,
  amount        DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  deliveries    INTEGER DEFAULT 0,
  status        VARCHAR(20) DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSING', 'PAID', 'FAILED')),
  payment_ref   VARCHAR(100),
  paid_at       TIMESTAMPTZ,
  initiated_by  UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpay_rider  ON rider_payouts(rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rpay_status ON rider_payouts(status) WHERE status IN ('PENDING', 'PROCESSING');

-- ═══════════════════════════════════════════════════════════════
-- 5. RIDER DOCUMENTS (KYC verification)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rider_documents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id    UUID REFERENCES users(id) NOT NULL,
  doc_type    VARCHAR(50) NOT NULL
                CHECK (doc_type IN ('aadhaar', 'license', 'vehicle_rc', 'pan', 'photo', 'bank_proof')),
  doc_url     TEXT NOT NULL,
  verified    BOOLEAN DEFAULT false,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rdoc_rider      ON rider_documents(rider_id);
CREATE INDEX IF NOT EXISTS idx_rdoc_unverified ON rider_documents(verified) WHERE verified = false;

-- ═══════════════════════════════════════════════════════════════
-- 6. NOTIFICATION TEMPLATES (reusable push templates)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notification_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  body        TEXT NOT NULL,
  image_url   TEXT,
  deep_link   TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- 7. NOTIFICATION CAMPAIGNS (bulk send history + stats)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notification_campaigns (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(255) NOT NULL,
  body          TEXT,
  image_url     TEXT,
  deep_link     TEXT,
  target_type   VARCHAR(50) NOT NULL
                  CHECK (target_type IN (
                    'all_customers', 'no_order_7_days', 'no_order_30_days',
                    'wishlist_users', 'high_value', 'custom_list', 'by_role'
                  )),
  target_count  INTEGER DEFAULT 0,
  sent_count    INTEGER DEFAULT 0,
  opened_count  INTEGER DEFAULT 0,
  failed_count  INTEGER DEFAULT 0,
  status        VARCHAR(20) DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SCHEDULED', 'CANCELLED')),
  template_id   UUID REFERENCES notification_templates(id) ON DELETE SET NULL,
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nc_status   ON notification_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_nc_created  ON notification_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nc_schedule ON notification_campaigns(scheduled_at)
  WHERE status = 'SCHEDULED';

-- ═══════════════════════════════════════════════════════════════
-- 8. BANNERS (homepage / offer banners for customer app)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS banners (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(200),
  subtitle      VARCHAR(300),
  image_url     TEXT NOT NULL,
  cta_text      VARCHAR(100),
  cta_link      TEXT,
  banner_type   VARCHAR(50) DEFAULT 'hero'
                  CHECK (banner_type IN ('hero', 'offer', 'popup', 'announcement', 'category')),
  display_order INTEGER DEFAULT 0,
  start_date    TIMESTAMPTZ,
  end_date      TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banners_active ON banners(is_active, display_order)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_banners_dates  ON banners(start_date, end_date);

-- ═══════════════════════════════════════════════════════════════
-- 9. ADMIN ACTIVITY LOG (audit trail)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id    UUID REFERENCES users(id) NOT NULL,
  action      VARCHAR(200) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  VARCHAR(50),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aal_admin  ON admin_activity_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_entity ON admin_activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_aal_date   ON admin_activity_log(created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 10. ALTER EXISTING TABLES
-- ═══════════════════════════════════════════════════════════════

-- 10a. users: add password_hash for admin email+password login
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- 10b. delivery_assignments: add GPS, timing, tip, customer rating columns
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS pickup_lat DECIMAL(10,8);
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS pickup_lng DECIMAL(11,8);
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS delivery_lat DECIMAL(10,8);
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS delivery_lng DECIMAL(11,8);
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS delivery_time_minutes INTEGER;
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS tip_amount DECIMAL(8,2) DEFAULT 0;

-- rating CHECK constraint needs DO $$ block for IF NOT EXISTS with CHECK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delivery_assignments' AND column_name = 'rating'
  ) THEN
    ALTER TABLE delivery_assignments ADD COLUMN rating INTEGER CHECK (rating >= 1 AND rating <= 5);
  END IF;
END $$;

ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS rating_note TEXT;

-- 10c. products: add sku column for barcode lookup
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku) WHERE sku IS NOT NULL;

-- 10d. products: add low_stock_threshold for configurable alerts
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER DEFAULT 10;

-- 10e. rider_profiles: add commission_rate
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,2) DEFAULT 15.00;

-- 10f. rider_profiles: add bank details for payouts
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(20);
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(15);
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);

-- ═══════════════════════════════════════════════════════════════
-- 11. SEED ADDITIONAL APP SETTINGS
-- ═══════════════════════════════════════════════════════════════
INSERT INTO app_settings (key, value, description) VALUES
  ('store_name',           '"Bakaloo"',              'Store display name'),
  ('store_gstin',          '"27AAAAA0000A1Z5"',     'GST number for invoices'),
  ('loyalty_rate',         '1',                     'Loyalty points per Rs.1 spent'),
  ('loyalty_value',        '0.01',                  'Value of 1 point in Rs.'),
  ('otp_expiry_sec',       '300',                   'OTP expiry in seconds'),
  ('low_stock_threshold',  '10',                    'Global low stock alert threshold'),
  ('max_bulk_assign',      '50',                    'Max orders per bulk assign'),
  ('rider_base_pay_3km',   '40',                    'Rider base pay (0-3 km) in Rs.'),
  ('rider_base_pay_5km',   '55',                    'Rider base pay (3-5 km) in Rs.'),
  ('rider_base_pay_8km',   '70',                    'Rider base pay (5-8 km) in Rs.'),
  ('rider_base_pay_above', '85',                    'Rider base pay (8+ km) in Rs.'),
  ('rider_rating_bonus',   '10',                    'Bonus per 4.5+ rated delivery in Rs.')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 12. ANALYTICS-SUPPORTING INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_oi_product_order ON order_items(product_id, order_id);

CREATE INDEX IF NOT EXISTS idx_orders_analytics ON orders(created_at, status)
  WHERE status NOT IN ('CANCELLED', 'REFUNDED');

CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_da_delivered ON delivery_assignments(rider_id, delivered_at DESC)
  WHERE status = 'DELIVERED';

CREATE INDEX IF NOT EXISTS idx_re_rider_date ON rider_earnings(rider_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pviews_analytics ON product_views(product_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_wt_type_date ON wallet_transactions(type, created_at DESC);
