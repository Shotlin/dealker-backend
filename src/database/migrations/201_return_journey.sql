-- Migration 201: return journey — pickup (Shiprocket / Porter / self), QC report with price revision,
-- and admin-editable return policy. Additive: existing refund requests are untouched.

CREATE TABLE IF NOT EXISTS return_settings (
  id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  window_days   INTEGER NOT NULL DEFAULT 7 CHECK (window_days BETWEEN 1 AND 90),
  free_pickup   BOOLEAN NOT NULL DEFAULT TRUE,
  policy_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO return_settings (id, policy_points) VALUES (1, '[
  {"title":"Original condition","text":"The product must be in its original condition with all accessories, box and invoice."},
  {"title":"Refund to your wallet","text":"Once the product passes our quality check, the refund is credited to your wallet."},
  {"title":"Free pickup","text":"We arrange the pickup from your address for eligible orders."},
  {"title":"Some items are not eligible","text":"Items marked non-returnable on the product page (for example some accessories) cannot be returned."}
]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS return_approved_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS refund_pickups (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_request_id    UUID NOT NULL UNIQUE REFERENCES refund_requests(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('SHIPROCKET', 'PORTER', 'BLUEDART', 'SELF')),
  awb                  VARCHAR(60),
  courier_name         VARCHAR(120),
  tracking_url         TEXT,
  status               TEXT NOT NULL DEFAULT 'PICKUP_SCHEDULED'
                         CHECK (status IN ('PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'FAILED', 'CANCELLED')),
  provider_status      VARCHAR(80),
  scheduled_at         TIMESTAMPTZ,
  picked_up_at         TIMESTAMPTZ,
  received_at          TIMESTAMPTZ,
  note                 TEXT,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refund_pickups_awb ON refund_pickups(awb) WHERE awb IS NOT NULL;

CREATE TABLE IF NOT EXISTS refund_pickup_events (
  id              BIGSERIAL PRIMARY KEY,
  pickup_id       UUID NOT NULL REFERENCES refund_pickups(id) ON DELETE CASCADE,
  status          VARCHAR(40) NOT NULL,
  provider_status VARCHAR(80),
  note            TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refund_pickup_events_pickup ON refund_pickup_events(pickup_id, occurred_at);

CREATE TABLE IF NOT EXISTS refund_qc (
  refund_request_id UUID PRIMARY KEY REFERENCES refund_requests(id) ON DELETE CASCADE,
  checks            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{key,label,status:OK|MINOR_ISSUE|FAILED,note?}]
  summary           TEXT,
  original_price    NUMERIC(12,2) NOT NULL,
  revised_price     NUMERIC(12,2) CHECK (revised_price IS NULL OR revised_price >= 0),
  price_status      TEXT NOT NULL DEFAULT 'NONE' CHECK (price_status IN ('NONE', 'PROPOSED', 'ACCEPTED', 'CLARIFICATION')),
  customer_message  TEXT,
  inspected_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  inspected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
