-- Vendor-to-vendor B2B: requirements → quotes → split awards → escrow payment → dispatch → receipt → settlement.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS b2b_commission_percent NUMERIC(5,2);
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_b2b_commission_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_b2b_commission_check CHECK (b2b_commission_percent IS NULL OR (b2b_commission_percent >= 0 AND b2b_commission_percent <= 50));

INSERT INTO app_settings (key, value, description)
VALUES ('b2b_commission_percent', '10'::jsonb, 'Default Dealker commission (%) charged to the seller on vendor-to-vendor orders')
ON CONFLICT (key) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS b2b_requirement_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS b2b_order_seq START 1000;

CREATE TABLE IF NOT EXISTS b2b_requirements (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requirement_number VARCHAR(20) NOT NULL UNIQUE,
  buyer_vendor_id   UUID REFERENCES vendors(id) ON DELETE SET NULL,
  posted_by_type    TEXT NOT NULL DEFAULT 'VENDOR' CHECK (posted_by_type IN ('VENDOR', 'ADMIN')),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  title             VARCHAR(200) NOT NULL,
  product_name      VARCHAR(200) NOT NULL,
  brand             VARCHAR(100),
  category_id       UUID REFERENCES categories(id) ON DELETE SET NULL,
  condition_pref    TEXT NOT NULL DEFAULT 'ANY' CHECK (condition_pref IN ('ANY', 'NEW', 'USED_OR_REFURBISHED')),
  quantity_needed   INTEGER NOT NULL CHECK (quantity_needed > 0),
  quantity_awarded  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_awarded >= 0),
  target_price      NUMERIC(12,2),
  description       TEXT,
  delivery_city     VARCHAR(100),
  delivery_pincode  VARCHAR(10),
  response_deadline TIMESTAMPTZ NOT NULL,
  required_by       DATE,
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'AWARDED', 'IN_FULFILMENT', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  cancel_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_req_status ON b2b_requirements (status, response_deadline);
CREATE INDEX IF NOT EXISTS idx_b2b_req_buyer ON b2b_requirements (buyer_vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS b2b_quotes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requirement_id    UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  seller_vendor_id  UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  quantity_offered  INTEGER NOT NULL CHECK (quantity_offered > 0),
  unit_price        NUMERIC(12,2) NOT NULL CHECK (unit_price > 0),
  condition         TEXT NOT NULL DEFAULT 'NEW' CHECK (condition IN ('NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR')),
  delivery_days     INTEGER NOT NULL DEFAULT 3 CHECK (delivery_days >= 0),
  note              TEXT,
  photos            JSONB NOT NULL DEFAULT '[]'::jsonb,
  quantity_awarded  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_awarded >= 0),
  status            TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'SELECTED', 'PARTIALLY_SELECTED', 'NOT_SELECTED', 'WITHDRAWN', 'EXPIRED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requirement_id, seller_vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_b2b_quotes_seller ON b2b_quotes (seller_vendor_id, status);

CREATE TABLE IF NOT EXISTS b2b_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requirement_id  UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  payer_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'ONLINE',
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'PARTIALLY_RELEASED', 'RELEASED', 'REFUNDED')),
  paid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS b2b_orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number        VARCHAR(20) NOT NULL UNIQUE,
  requirement_id      UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  quote_id            UUID NOT NULL REFERENCES b2b_quotes(id) ON DELETE RESTRICT,
  payment_id          UUID REFERENCES b2b_payments(id) ON DELETE SET NULL,
  buyer_vendor_id     UUID REFERENCES vendors(id) ON DELETE SET NULL,
  seller_vendor_id    UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price          NUMERIC(12,2) NOT NULL,
  subtotal            NUMERIC(12,2) NOT NULL,
  commission_percent  NUMERIC(5,2) NOT NULL DEFAULT 10,
  commission_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_payable      NUMERIC(12,2) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN
    ('PENDING_PAYMENT', 'PAID', 'PACKED', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED', 'REFUNDED')),
  payment_status      TEXT NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'ESCROW_HELD', 'RELEASED', 'REFUNDED')),
  courier_name        VARCHAR(100),
  awb                 VARCHAR(100),
  tracking_url        TEXT,
  paid_at             TIMESTAMPTZ,
  packed_at           TIMESTAMPTZ,
  dispatched_at       TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  received_at         TIMESTAMPTZ,
  received_quantity   INTEGER,
  receipt_note        TEXT,
  released_at         TIMESTAMPTZ,
  released_amount     NUMERIC(12,2),
  dispute_status      TEXT CHECK (dispute_status IN ('OPEN', 'RESOLVED_RELEASED', 'RESOLVED_REFUNDED', 'RESOLVED_PARTIAL')),
  dispute_reason      TEXT,
  dispute_resolution  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_status ON b2b_orders (status);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_seller ON b2b_orders (seller_vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_buyer ON b2b_orders (buyer_vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_req ON b2b_orders (requirement_id);

CREATE TABLE IF NOT EXISTS b2b_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requirement_id UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  order_id       UUID REFERENCES b2b_orders(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  actor_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_label    TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_events_req ON b2b_events (requirement_id, created_at);
