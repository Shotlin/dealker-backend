-- 150_shiprocket_shipments.sql
-- Global delivery-partner switch + one Shiprocket Quick shipment per order.
ALTER TABLE shiprocket_settings
  ADD COLUMN IF NOT EXISTS delivery_partner VARCHAR(20) NOT NULL DEFAULT 'OWN_RIDERS';
DO $$ BEGIN
  ALTER TABLE shiprocket_settings ADD CONSTRAINT chk_shiprocket_delivery_partner
    CHECK (delivery_partner IN ('OWN_RIDERS', 'SHIPROCKET'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS shiprocket_shipments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  sr_order_ref     TEXT NOT NULL,            -- the order_id we sent (order_number + suffix)
  sr_order_id      BIGINT NULL,              -- Shiprocket's order id
  sr_shipment_id   BIGINT NULL,
  awb_code         TEXT NULL,
  courier_name     TEXT NULL,
  rate             NUMERIC(10,2) NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'CREATED'
                    CONSTRAINT chk_sr_shipment_status CHECK (status IN
                      ('CREATED','ASSIGNING','ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','FAILED')),
  sr_status        TEXT NULL,                -- raw Shiprocket status text
  agent_name       TEXT NULL,
  agent_phone      TEXT NULL,
  tracking_url     TEXT NULL,
  last_error       TEXT NULL,
  created_by       UUID NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sr_shipments_active
  ON shiprocket_shipments (status)
  WHERE status IN ('CREATED','ASSIGNING','ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY');
