-- Devices carry their own state: AVAILABLE → RESERVED (in a B2B order) → PACKED → SOLD. The buyer picks specific devices.
ALTER TABLE listing_units ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'AVAILABLE'
  CHECK (status IN ('AVAILABLE', 'RESERVED', 'PACKED', 'SOLD'));
ALTER TABLE listing_units ADD COLUMN IF NOT EXISTS b2b_order_id UUID REFERENCES b2b_orders(id) ON DELETE SET NULL;
ALTER TABLE listing_units ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
ALTER TABLE listing_units ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_listing_units_status ON listing_units (shop_product_id, status, unit_no);
CREATE INDEX IF NOT EXISTS idx_listing_units_order ON listing_units (b2b_order_id) WHERE b2b_order_id IS NOT NULL;

-- Until now the first (units − stock) devices were treated as sold; make that explicit.
UPDATE listing_units u SET status = 'SOLD'
  FROM (SELECT l.shop_product_id, l.unit_no,
               GREATEST(0, COUNT(*) OVER (PARTITION BY l.shop_product_id) - sp.stock_quantity) AS sold_n,
               ROW_NUMBER() OVER (PARTITION BY l.shop_product_id ORDER BY l.unit_no) AS rn
          FROM listing_units l JOIN shop_products sp ON sp.id = l.shop_product_id) x
 WHERE u.shop_product_id = x.shop_product_id AND u.unit_no = x.unit_no AND x.rn <= x.sold_n AND u.status = 'AVAILABLE';
