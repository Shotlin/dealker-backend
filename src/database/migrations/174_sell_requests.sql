-- 174_sell_requests.sql
-- Sell & Exchange requests: a customer sells (or trades in) a used device. The platform
-- computes a quote from the condition answers, vendors place offers, an admin assigns a
-- vendor and approves. Additive & idempotent.

-- ── Valuation rules (singleton) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sell_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Each key is a deduction rule; see modules/sell-requests/valuation.js DEFAULT_RULES.
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_total_deduction_pct NUMERIC(5,2) NOT NULL DEFAULT 85 CHECK (max_total_deduction_pct BETWEEN 0 AND 100),
  variant_step_pct NUMERIC(5,2) NOT NULL DEFAULT 8 CHECK (variant_step_pct BETWEEN 0 AND 50),
  max_images INTEGER NOT NULL DEFAULT 8 CHECK (max_images BETWEEN 0 AND 20),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sell_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── Device catalogue ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sell_device_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('Smartphone', 'Tablet', 'Laptop')),
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ordered lowest → highest
  colors JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_price NUMERIC(10,2) NOT NULL CHECK (base_price > 0),  -- top variant, mint condition
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sell_device_models (name, category, variants, colors, base_price) VALUES
  ('iPhone 14', 'Smartphone', '["128GB","256GB","512GB"]', '["White","Midnight","Blue","Purple"]', 46000),
  ('iPhone 13', 'Smartphone', '["128GB","256GB"]', '["Midnight","Blue","Pink"]', 36000),
  ('iPhone 12', 'Smartphone', '["64GB","128GB"]', '["Black","Blue","Green"]', 30000),
  ('Samsung S23 Ultra', 'Smartphone', '["256GB","512GB"]', '["Phantom Black","Green","Cream"]', 68000),
  ('Samsung S22', 'Smartphone', '["128GB","256GB"]', '["Green","Phantom Black"]', 40000),
  ('OnePlus 11R', 'Smartphone', '["8GB + 128GB","16GB + 256GB"]', '["Sonic Black","Galactic Silver"]', 43000),
  ('Realme 10 Pro+', 'Smartphone', '["8GB + 128GB"]', '["Blue","Black"]', 24000),
  ('Redmi Note 12', 'Smartphone', '["6GB + 128GB"]', '["Onyx Black","Mint Green"]', 18000),
  ('Oppo Reno 8', 'Smartphone', '["8GB + 128GB"]', '["Glowing Black","Shimmer Gold"]', 20000),
  ('Vivo V27', 'Smartphone', '["8GB + 128GB"]', '["Magic Blue","Noble Black"]', 16000),
  ('iPad 9th Gen', 'Tablet', '["64GB","256GB"]', '["Space Grey","Silver"]', 30000),
  ('MacBook Air M1', 'Laptop', '["8GB / 256GB","8GB / 512GB"]', '["Silver","Space Grey","Gold"]', 52000),
  ('Lenovo Laptop', 'Laptop', '["i5 / 8GB / 512GB"]', '["Grey"]', 23000)
ON CONFLICT (name) DO NOTHING;

-- ── Requests ────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS sell_request_seq START 100001;

CREATE TABLE IF NOT EXISTS sell_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('SELL_TO_AB', 'BUY_NOW', 'EXCHANGE')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'IN_PROGRESS', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED')),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,          -- NULL when an admin keys it in for a walk-in
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  customer_email VARCHAR(255),
  customer_city VARCHAR(100),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (created_by_role IN ('CUSTOMER', 'ADMIN')),

  model_id UUID REFERENCES sell_device_models(id) ON DELETE SET NULL,
  model_name VARCHAR(120) NOT NULL,
  variant VARCHAR(60) NOT NULL,
  color VARCHAR(60) NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Smartphone', 'Tablet', 'Laptop')),
  imei VARCHAR(15) NOT NULL CHECK (imei ~ '^[0-9]{15}$'),

  qa JSONB NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('EXCELLENT', 'GOOD', 'FAIR', 'POOR')),
  base_price NUMERIC(10,2) NOT NULL,
  quote NUMERIC(10,2) NOT NULL CHECK (quote >= 0),
  deductions JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_price NUMERIC(10,2) NOT NULL CHECK (expected_price >= 0),
  description TEXT NOT NULL DEFAULT '',
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  exchange JSONB,                                                 -- {newProduct,newProductPrice,tradeInValue,payable}

  assigned_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  final_price NUMERIC(10,2),                                      -- accepted offer amount
  admin_note TEXT,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (type <> 'EXCHANGE' OR exchange IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_sell_requests_status_created ON sell_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sell_requests_user ON sell_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sell_requests_vendor ON sell_requests (assigned_vendor_id) WHERE assigned_vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sell_requests_phone ON sell_requests (customer_phone);
CREATE INDEX IF NOT EXISTS idx_sell_requests_search ON sell_requests
  USING gin ((code || ' ' || model_name || ' ' || customer_name || ' ' || imei) gin_trgm_ops);
-- One live request per physical device.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sell_requests_active_imei ON sell_requests (imei)
  WHERE status IN ('PENDING', 'IN_PROGRESS', 'APPROVED');

-- ── Vendor offers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sell_request_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES sell_requests(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  note VARCHAR(300),
  distance_km NUMERIC(6,1),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_sell_offers_vendor ON sell_request_offers (vendor_id, status);

-- ── Timeline (append-only) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sell_request_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES sell_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sell_events_request ON sell_request_events (request_id, id);

-- ── RBAC ────────────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['sell_requests.view', 'sell_requests.manage', 'sell_requests.settings'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');

UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['sell_requests.view'])
           ) s)))
 WHERE name IN ('Marketing Manager', 'Catalog Manager')
   AND NOT (permissions ? '*');

COMMENT ON TABLE sell_requests IS 'Customer sell / exchange requests for used devices. quote is server-computed from qa; never trust a client-supplied quote.';
COMMENT ON TABLE sell_request_events IS 'Append-only request timeline.';
