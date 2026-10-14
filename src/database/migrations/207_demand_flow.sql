-- 207_demand_flow.sql
-- Vendor Demand flow on top of the B2B requirement → quote → award → escrow → dispatch → receive pipeline (168).
--
--  1. A requirement carries what a buyer really asks for: storage, a price RANGE, minimum battery,
--     display preference, pickup/delivery preference, an urgent flag, and a normalised model key
--     that powers "Match Found — you have 6 in stock" and catalogue thumbnails.
--  2. Per-vendor view log: "new" (unseen) demand, "Not interested" (dismissed), and view counts
--     for the dashboard. One row per (requirement, vendor).
--  3. Quotes remember when the buyer first opened them ("Viewed") and which listing they came from.
--  4. Orders: pickup vs courier delivery (+ pickup slot) and how the buyer paid.
--  5. Escrow is now real money for vendor payers: paying from the Dealker wallet debits the
--     buyer's settlement ledger, refunds credit it back. Both ledger rows carry their own reason codes.
-- Additive and idempotent.

ALTER TABLE b2b_requirements
  ADD COLUMN IF NOT EXISTS model_key          VARCHAR(160),
  ADD COLUMN IF NOT EXISTS storage            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS target_price_max   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS min_battery_health SMALLINT,
  ADD COLUMN IF NOT EXISTS display_pref       TEXT NOT NULL DEFAULT 'ANY',
  ADD COLUMN IF NOT EXISTS fulfilment_pref    TEXT NOT NULL DEFAULT 'ANY',
  ADD COLUMN IF NOT EXISTS is_urgent          BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'b2b_req_display_pref_check') THEN
    ALTER TABLE b2b_requirements ADD CONSTRAINT b2b_req_display_pref_check CHECK (display_pref IN ('ANY', 'ORIGINAL', 'GRADE_AB'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'b2b_req_fulfilment_pref_check') THEN
    ALTER TABLE b2b_requirements ADD CONSTRAINT b2b_req_fulfilment_pref_check CHECK (fulfilment_pref IN ('ANY', 'PICKUP', 'DELIVERY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'b2b_req_battery_check') THEN
    ALTER TABLE b2b_requirements ADD CONSTRAINT b2b_req_battery_check CHECK (min_battery_health IS NULL OR min_battery_health BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'b2b_req_price_range_check') THEN
    ALTER TABLE b2b_requirements ADD CONSTRAINT b2b_req_price_range_check CHECK (target_price_max IS NULL OR target_price IS NULL OR target_price_max >= target_price);
  END IF;
END $$;

-- Existing rows: derive storage + model key from the product name (same rule the API applies on create).
UPDATE b2b_requirements
   SET storage = upper(regexp_replace((regexp_match(product_name, '(\d{1,4})\s*(gb|tb)', 'i'))[1] || (regexp_match(product_name, '(\d{1,4})\s*(gb|tb)', 'i'))[2], '\s', '', 'g'))
 WHERE storage IS NULL AND product_name ~* '\d{1,4}\s*(gb|tb)';

UPDATE b2b_requirements
   SET model_key = btrim(regexp_replace(regexp_replace(lower(product_name), '\d{1,4}\s*(gb|tb)', ' ', 'gi'), '[^a-z0-9]+', ' ', 'g'))
 WHERE model_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_req_model_key ON b2b_requirements (model_key);

CREATE TABLE IF NOT EXISTS b2b_requirement_views (
  requirement_id UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  views          INTEGER NOT NULL DEFAULT 1,
  dismissed_at   TIMESTAMPTZ,
  PRIMARY KEY (requirement_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_b2b_req_views_vendor ON b2b_requirement_views (vendor_id, dismissed_at);

ALTER TABLE b2b_quotes
  ADD COLUMN IF NOT EXISTS buyer_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS listing_id      UUID REFERENCES shop_products(id) ON DELETE SET NULL;

ALTER TABLE b2b_orders
  ADD COLUMN IF NOT EXISTS fulfilment_type TEXT NOT NULL DEFAULT 'DELIVERY',
  ADD COLUMN IF NOT EXISTS pickup_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_note     TEXT,
  ADD COLUMN IF NOT EXISTS payment_method  TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'b2b_orders_fulfilment_type_check') THEN
    ALTER TABLE b2b_orders ADD CONSTRAINT b2b_orders_fulfilment_type_check CHECK (fulfilment_type IN ('DELIVERY', 'PICKUP'));
  END IF;
END $$;

-- Funnel / insight queries (dashboard) group by day and join quotes ↔ requirements.
CREATE INDEX IF NOT EXISTS idx_b2b_quotes_req_created ON b2b_quotes (requirement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_b2b_req_created ON b2b_requirements (created_at DESC);
