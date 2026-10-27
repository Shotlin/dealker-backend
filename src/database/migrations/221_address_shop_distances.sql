-- 221_address_shop_distances.sql
-- Saved road distances between a customer's pinned location and a vendor shop.
-- One Ola Maps call per (origin, shop) pair, then reused forever (until the shop pin moves), so the same
-- address never triggers another map request. Additive and idempotent.
CREATE TABLE IF NOT EXISTS address_shop_distances (
  origin_key   TEXT        NOT NULL,                       -- "lat,lng" rounded to 4 decimals (~11 m)
  shop_id      UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  origin_lat   NUMERIC(9,6) NOT NULL,
  origin_lng   NUMERIC(9,6) NOT NULL,
  shop_lat     NUMERIC(9,6) NOT NULL,                      -- shop pin used for the calculation (detects a moved shop)
  shop_lng     NUMERIC(9,6) NOT NULL,
  km           NUMERIC(8,2) NOT NULL,
  minutes      INTEGER,
  method       TEXT        NOT NULL CHECK (method IN ('ROAD', 'EST')),  -- EST = straight-line x 1.3 fallback, retried later
  address_id   UUID,                                       -- last address that asked (informational)
  user_id      UUID,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (origin_key, shop_id)
);
CREATE INDEX IF NOT EXISTS idx_asd_address ON address_shop_distances (address_id) WHERE address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asd_user ON address_shop_distances (user_id) WHERE user_id IS NOT NULL;
