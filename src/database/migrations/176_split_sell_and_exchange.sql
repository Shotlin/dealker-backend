-- 176_split_sell_and_exchange.sql
-- Sell requests and Exchange requests are separate products with separate sections:
--   SELL      = customer sells an old device (SELL_TO_AB / BUY_NOW)       codes SELL-xxxxxx
--   EXCHANGE  = customer buys a new device and trades the old one in      codes EXCH-xxxxxx
-- They share the valuation engine and table, but every API, number range and permission is separate.
-- Additive & idempotent.

ALTER TABLE sell_requests
  ADD COLUMN IF NOT EXISTS kind TEXT GENERATED ALWAYS AS (CASE WHEN type = 'EXCHANGE' THEN 'EXCHANGE' ELSE 'SELL' END) STORED,
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_sell_requests_kind_status ON sell_requests (kind, status, created_at DESC);

CREATE SEQUENCE IF NOT EXISTS exchange_request_seq START 200001;

-- Exchanges created before the split carried SELL- codes; move them into the EXCH- range.
UPDATE sell_requests s
   SET code = 'EXCH-' || nextval('exchange_request_seq')
  FROM (SELECT id FROM sell_requests WHERE type = 'EXCHANGE' AND code LIKE 'SELL-%' ORDER BY created_at, id) o
 WHERE s.id = o.id;

-- ── RBAC: exchange_requests.* is its own permission set ─────────────────
UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['exchange_requests.view', 'exchange_requests.manage'])
           ) s)))
 WHERE name IN ('Platform Admin')
   AND NOT (permissions ? '*');

UPDATE roles
   SET permissions = (
         SELECT to_jsonb(ARRAY(
           SELECT DISTINCT e FROM (
             SELECT jsonb_array_elements_text(permissions) AS e
             UNION SELECT unnest(ARRAY['exchange_requests.view'])
           ) s)))
 WHERE name IN ('Marketing Manager', 'Catalog Manager')
   AND NOT (permissions ? '*');

COMMENT ON COLUMN sell_requests.kind IS 'SELL or EXCHANGE — derived from type. Every API filters on it so the two sections never mix.';
COMMENT ON COLUMN sell_requests.is_demo IS 'Rows created by the demo seed (npm run seed:sell-demo). Safe to delete with --reset.';
