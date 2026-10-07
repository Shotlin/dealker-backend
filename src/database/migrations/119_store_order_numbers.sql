-- Customer-facing order numbers: FC-{store short code}-{YYYYMMDD}-{sequence}.
-- The sequence is stored per shop and calendar day so concurrent checkouts
-- cannot produce a duplicate number.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS order_prefix VARCHAR(8);

UPDATE shops
   SET order_prefix = CASE
     WHEN name ILIKE '%HQ Central%' THEN 'HQC'
     WHEN name ILIKE '%Kolkata%' THEN 'KOL'
     ELSE LEFT(REGEXP_REPLACE(UPPER(name), '[^A-Z0-9]', '', 'g'), 8)
   END
 WHERE order_prefix IS NULL OR order_prefix = '';

CREATE TABLE IF NOT EXISTS order_number_sequences (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_date DATE NOT NULL,
  last_value INTEGER NOT NULL CHECK (last_value > 0),
  PRIMARY KEY (shop_id, order_date)
);
