-- 223_exchange_programs.sql
-- Exchange for ANY product, not just phones.
--   exchange_device_types  which kinds of OLD device Dealker accepts (Smartphone, Headphones, Smartwatch …)
--                          and which questions the app must ask for each kind.
--   exchange_programs      "when a customer buys a product in these categories, they may trade in these
--                          device types". The dashboard owns both tables; the product page reads them.
-- The valuation engine, catalogue (sell_device_models) and requests table are shared with Sell.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS exchange_device_types (
  key          TEXT PRIMARY KEY,                       -- value stored in sell_device_models.category
  label        TEXT NOT NULL,
  icon         TEXT NOT NULL DEFAULT 'other',          -- phone|tablet|laptop|headphones|watch|speaker|camera|console|other
  needs_imei   BOOLEAN NOT NULL DEFAULT FALSE,         -- ask for IMEI (phones/tablets); else an optional serial
  has_screen   BOOLEAN NOT NULL DEFAULT TRUE,          -- screen scratches / screen replaced questions
  has_battery  BOOLEAN NOT NULL DEFAULT TRUE,          -- battery health question
  has_camera   BOOLEAN NOT NULL DEFAULT FALSE,         -- camera / fingerprint issue questions
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO exchange_device_types (key, label, icon, needs_imei, has_screen, has_battery, has_camera, sort_order) VALUES
  ('Smartphone', 'Smartphone', 'phone',      TRUE,  TRUE,  TRUE,  TRUE,  1),
  ('Tablet',     'Tablet',     'tablet',     TRUE,  TRUE,  TRUE,  TRUE,  2),
  ('Laptop',     'Laptop',     'laptop',     FALSE, TRUE,  TRUE,  FALSE, 3),
  ('Headphones', 'Headphones & earbuds', 'headphones', FALSE, FALSE, TRUE, FALSE, 4),
  ('Smartwatch', 'Smartwatch', 'watch',      FALSE, TRUE,  TRUE,  FALSE, 5),
  ('Speaker',    'Speaker',    'speaker',    FALSE, FALSE, TRUE,  FALSE, 6)
ON CONFLICT (key) DO NOTHING;

-- The catalogue and requests may now hold any active device type.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('sell_device_models'::regclass, 'sell_requests'::regclass)
       AND (pg_get_constraintdef(oid) ILIKE '%Smartphone%' OR pg_get_constraintdef(oid) ~* 'imei')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- IMEI stays a 15-digit number for phones; other devices store an optional serial (or an NA- placeholder).
ALTER TABLE sell_requests ALTER COLUMN imei TYPE VARCHAR(32);
ALTER TABLE sell_requests
  ADD CONSTRAINT sell_requests_imei_format CHECK (imei ~ '^[0-9]{15}$' OR imei ~ '^[A-Za-z0-9-]{3,32}$');

CREATE TABLE IF NOT EXISTS exchange_programs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  device_types  TEXT[] NOT NULL DEFAULT '{}',          -- old-device types accepted (exchange_device_types.key)
  category_ids  UUID[] NOT NULL DEFAULT '{}',          -- store categories (and their sub-categories) it applies to
  product_ids   UUID[] NOT NULL DEFAULT '{}',          -- extra individual products
  max_value_pct NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (max_value_pct > 0 AND max_value_pct <= 100),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE exchange_programs IS 'Which products can be bought with an exchange, and which old devices are accepted for them. max_value_pct caps the trade-in value as a share of the new product price.';
