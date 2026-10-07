-- 158_shipping.sql
-- Normalized marketplace shipping: shipments per seller order, append-only
-- tracking events, per-provider encrypted credential settings and admin
-- routing rules. Shiprocket credentials continue to live in shiprocket_settings
-- (149); this table covers Blue Dart / Porter and future providers.

CREATE TABLE IF NOT EXISTS shipping_provider_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL UNIQUE
    CHECK (provider IN ('SHIPROCKET', 'BLUEDART', 'PORTER')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mode TEXT NOT NULL DEFAULT 'TEST' CHECK (mode IN ('TEST', 'PRODUCTION')),
  -- Encrypted at rest with SETTINGS_ENCRYPTION_KEY (AES-256-GCM) via
  -- src/utils/encryption.js. Never store plaintext secrets.
  api_key_encrypted TEXT,
  api_secret_encrypted TEXT,
  account_number_encrypted TEXT,
  extra_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at TIMESTAMP,
  last_test_status TEXT CHECK (last_test_status IN ('SUCCESS', 'FAILED')),
  last_test_message TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO shipping_provider_settings (provider, enabled) VALUES ('SHIPROCKET', TRUE)
  ON CONFLICT (provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_order_id UUID NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('SHIPROCKET', 'BLUEDART', 'PORTER', 'SELF')),
  provider_order_id VARCHAR(60),
  provider_shipment_id VARCHAR(60),
  awb VARCHAR(60),
  courier_name VARCHAR(120),
  pickup_location VARCHAR(160),
  shipping_charge DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (shipping_charge >= 0),
  cod_amount DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (cod_amount >= 0),
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'ASSIGNING', 'ASSIGNED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED', 'RTO')),
  provider_status VARCHAR(60),
  estimated_delivery TIMESTAMP,
  tracking_url TEXT,
  label_url TEXT,
  manifest_url TEXT,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_seller_order ON shipments(seller_order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_awb ON shipments(awb) WHERE awb IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipment_events (
  id BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status VARCHAR(60) NOT NULL,
  provider_status VARCHAR(60),
  note TEXT,
  event_location VARCHAR(160),
  occurred_at TIMESTAMP,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment ON shipment_events(shipment_id, occurred_at);

CREATE TABLE IF NOT EXISTS shipping_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Matching criteria (NULL = wildcard)
  pickup_pincode_prefix VARCHAR(6),
  delivery_pincode_prefix VARCHAR(6),
  max_weight_grams INTEGER,
  cod_allowed BOOLEAN,
  -- Routing outcome
  preferred_provider TEXT CHECK (preferred_provider IN ('SHIPROCKET', 'BLUEDART', 'PORTER', 'SELF')),
  fallback_provider TEXT CHECK (fallback_provider IN ('SHIPROCKET', 'BLUEDART', 'PORTER', 'SELF')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Local delivery stays eligible for Porter/hyperlocal; everything else
-- falls back to the national aggregator. A missing match = SHIPROCKET.
INSERT INTO shipping_rules (name, priority, preferred_provider, fallback_provider)
VALUES ('Default national routing', 1000, 'SHIPROCKET', 'BLUEDART')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE shipments IS 'One shipment per seller_order (UQ). Provider statuses map through the adapter layer into the internal status vocabulary — external status never overwrites internal state directly.';
