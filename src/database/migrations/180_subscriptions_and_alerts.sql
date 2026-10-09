-- 180_subscriptions_and_alerts.sql
-- Vendor subscriptions (Free / Paid / Premium / Unlimited) with listing limits,
-- history and expiry, plus the admin alert feed that powers the notification
-- centre. Additive and idempotent.

-- ── 1. Plans ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL UNIQUE CHECK (tier IN ('FREE', 'PAID', 'PREMIUM', 'UNLIMITED')),
  name TEXT NOT NULL,
  description TEXT,
  price_monthly NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  price_yearly NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_yearly >= 0),
  listing_limit INTEGER CHECK (listing_limit IS NULL OR listing_limit >= 0),  -- NULL = unlimited
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO subscription_plans (tier, name, description, price_monthly, price_yearly, listing_limit, features, sort_order) VALUES
  ('FREE', 'Free', 'Get started — list a few products at no cost.', 0, 0, 25,
   '["Up to 25 listings", "Standard support"]', 1),
  ('PAID', 'Paid', 'For growing sellers.', 999, 9990, 200,
   '["Up to 200 listings", "Priority listing review", "Sponsored ads access"]', 2),
  ('PREMIUM', 'Premium', 'For established stores.', 2999, 29990, 1000,
   '["Up to 1,000 listings", "Fast-track QC", "Sponsored ads access", "Auction access", "Dedicated manager"]', 3),
  ('UNLIMITED', 'Unlimited', 'No limits for large vendors.', 7999, 79990, NULL,
   '["Unlimited listings", "Fast-track QC", "Sponsored ads access", "Auction access", "Dedicated manager", "Lowest platform charges"]', 4)
ON CONFLICT (tier) DO NOTHING;

-- ── 2. Vendor subscriptions ───────────────────────────────────────────────
-- A vendor with no ACTIVE row is on the Free plan. Rows are history: changing
-- plan cancels the old row and inserts a new one.
CREATE TABLE IF NOT EXISTS vendor_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('MONTHLY', 'YEARLY', 'COMPLIMENTARY')),
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  payment_ref TEXT,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  cancelled_at TIMESTAMP,
  cancel_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_subscriptions_active ON vendor_subscriptions(vendor_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_expiry ON vendor_subscriptions(expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_vendor ON vendor_subscriptions(vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_events (
  id BIGSERIAL PRIMARY KEY,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES vendor_subscriptions(id) ON DELETE SET NULL,
  event TEXT NOT NULL CHECK (event IN ('ASSIGNED', 'CHANGED', 'RENEWED', 'EXTENDED', 'CANCELLED', 'EXPIRED', 'EXPIRING_SOON')),
  from_tier TEXT,
  to_tier TEXT,
  detail JSONB,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_vendor ON subscription_events(vendor_id, created_at DESC);

-- ── 3. Admin alert feed (notification centre) ─────────────────────────────
CREATE TABLE IF NOT EXISTS admin_alerts (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id TEXT,
  link TEXT,
  data JSONB,
  dedupe_key TEXT UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_created ON admin_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_type ON admin_alerts(type, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_alert_reads (
  alert_id BIGINT NOT NULL REFERENCES admin_alerts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_id, user_id)
);

-- ── 4. Permissions ────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['subscriptions.view','subscriptions.manage','alerts.view'])))
   )
 WHERE name IN ('Platform Admin', 'Finance Manager');
