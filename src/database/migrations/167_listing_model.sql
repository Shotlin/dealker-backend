ALTER TABLE order_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Listing model: every product row is ONE seller's listing (own photos, condition, price).
-- Admin listings live on the platform shop "Dealker Official"; vendor listings on the vendor's shop.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS owner_type          TEXT NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN IF NOT EXISTS owner_vendor_id     UUID REFERENCES vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS condition           TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS condition_notes     TEXT,
  ADD COLUMN IF NOT EXISTS usage_duration      TEXT,
  ADD COLUMN IF NOT EXISTS warranty_info       TEXT,
  ADD COLUMN IF NOT EXISTS accessories_included TEXT,
  ADD COLUMN IF NOT EXISTS battery_health      SMALLINT,
  ADD COLUMN IF NOT EXISTS serial_number       TEXT,
  ADD COLUMN IF NOT EXISTS has_invoice         BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_owner_type_check;
ALTER TABLE products ADD CONSTRAINT products_owner_type_check CHECK (owner_type IN ('ADMIN', 'VENDOR'));
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_condition_check;
ALTER TABLE products ADD CONSTRAINT products_condition_check
  CHECK (condition IN ('NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR'));
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_battery_health_check;
ALTER TABLE products ADD CONSTRAINT products_battery_health_check CHECK (battery_health IS NULL OR (battery_health BETWEEN 1 AND 100));

CREATE INDEX IF NOT EXISTS idx_products_owner ON products (owner_type, owner_vendor_id);
CREATE INDEX IF NOT EXISTS idx_products_condition ON products (condition);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_platform BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shops_platform ON shops (is_platform) WHERE is_platform = true;

INSERT INTO shops (name, slug, branch_code, description, address_line1, city, state, pincode, lat, lng, is_active, is_verified,
                   commission_rate, is_platform, pickup_capable, order_prefix)
SELECT 'Dealker Official', 'dealker-official', 'DKHQ', 'Products listed directly by Dealker', 'Dealker HQ', 'Bengaluru', 'Karnataka', '560001',
       12.9716, 77.5946, true, true, 0, true, true, 'DKHQ'
WHERE NOT EXISTS (SELECT 1 FROM shops WHERE is_platform = true);

-- ── Data migration: one product row per seller listing ───────────────────
CREATE TEMP TABLE _listing_map ON COMMIT DROP AS
SELECT sp.id AS sp_id, sp.product_id AS old_pid, sp.shop_id, s.vendor_id, gen_random_uuid() AS new_pid
  FROM shop_products sp
  JOIN shops s ON s.id = sp.shop_id
 WHERE s.is_platform = false AND sp.deleted_at IS NULL;

INSERT INTO products (id, name, slug, description, price, sale_price, cost_price, category_id, stock_quantity, unit, thumbnail_url, images,
                      tags, is_active, is_featured, total_sold, sku, low_stock_threshold, barcode, max_order_qty, brand, avg_rating, rating_count,
                      hsn_code, gst_rate, specifications, return_policy_days, owner_type, owner_vendor_id, condition, condition_notes,
                      usage_duration, warranty_info, accessories_included, battery_health, has_invoice, created_at, updated_at)
SELECT m.new_pid, p.name, p.slug || '-' || substr(m.new_pid::text, 1, 6), p.description,
       COALESCE(sp.mrp, p.price), COALESCE(sp.sale_price, sp.price, p.sale_price), p.cost_price, p.category_id, sp.stock_quantity, p.unit,
       'https://picsum.photos/seed/' || substr(m.new_pid::text, 1, 8) || '-1/600/600',
       jsonb_build_array(
         'https://picsum.photos/seed/' || substr(m.new_pid::text, 1, 8) || '-1/600/600',
         'https://picsum.photos/seed/' || substr(m.new_pid::text, 1, 8) || '-2/600/600',
         'https://picsum.photos/seed/' || substr(m.new_pid::text, 1, 8) || '-3/600/600',
         'https://picsum.photos/seed/' || substr(m.new_pid::text, 1, 8) || '-4/600/600'),
       p.tags, sp.is_available, false, COALESCE(sp.sold_count, 0), COALESCE(sp.seller_sku, p.sku), COALESCE(sp.low_stock_threshold, 10),
       p.barcode, COALESCE(sp.max_order_qty, 10), p.brand, p.avg_rating, p.rating_count, p.hsn_code, p.gst_rate, p.specifications,
       p.return_policy_days, 'VENDOR', m.vendor_id,
       (ARRAY['NEW','NEW','OPEN_BOX','REFURBISHED','USED_LIKE_NEW','USED_GOOD','USED_FAIR'])[1 + (abs(hashtext(m.new_pid::text)) % 7)],
       NULL, NULL, NULL, NULL, NULL, false, sp.created_at, NOW()
  FROM _listing_map m
  JOIN shop_products sp ON sp.id = m.sp_id
  JOIN products p ON p.id = m.old_pid;

-- condition-specific details
UPDATE products SET
  condition_notes = CASE condition
    WHEN 'OPEN_BOX' THEN 'Box opened for inspection only. Unused, all seals and accessories intact.'
    WHEN 'REFURBISHED' THEN 'Professionally refurbished and tested. Fully functional with new-like finish.'
    WHEN 'USED_LIKE_NEW' THEN 'Used gently. No visible scratches or dents.'
    WHEN 'USED_GOOD' THEN 'Fully working. Light scratches on body, no cracks.'
    WHEN 'USED_FAIR' THEN 'Fully working. Visible scratches and minor dents from regular use.'
    ELSE NULL END,
  usage_duration = CASE condition
    WHEN 'USED_LIKE_NEW' THEN '2 months' WHEN 'USED_GOOD' THEN '6 months' WHEN 'USED_FAIR' THEN '14 months'
    WHEN 'REFURBISHED' THEN 'Refurbished' ELSE NULL END,
  warranty_info = CASE condition
    WHEN 'NEW' THEN '1 year manufacturer warranty' WHEN 'OPEN_BOX' THEN '1 year brand warranty'
    WHEN 'REFURBISHED' THEN '6 months seller warranty' WHEN 'USED_LIKE_NEW' THEN '3 months seller warranty'
    WHEN 'USED_GOOD' THEN '1 month seller warranty' ELSE 'No warranty' END,
  accessories_included = CASE WHEN condition IN ('NEW','OPEN_BOX') THEN 'Original box, charger and manuals'
                              WHEN condition = 'USED_FAIR' THEN 'Unit only' ELSE 'Charger included' END,
  has_invoice = condition IN ('NEW','OPEN_BOX','REFURBISHED','USED_LIKE_NEW')
 WHERE owner_type = 'VENDOR' AND condition_notes IS NULL AND warranty_info IS NULL;

UPDATE products SET battery_health = 78 + (abs(hashtext(id::text)) % 20)
 WHERE owner_type = 'VENDOR' AND condition IN ('USED_LIKE_NEW','USED_GOOD','USED_FAIR','REFURBISHED')
   AND category_id IN (SELECT id FROM categories WHERE name = 'Electronics');

-- Re-point history to the listing's own product row
UPDATE order_items oi SET product_id = m.new_pid FROM _listing_map m WHERE oi.shop_product_id = m.sp_id;
UPDATE shop_products sp SET product_id = m.new_pid FROM _listing_map m WHERE sp.id = m.sp_id;
UPDATE reviews r SET product_id = m.new_pid
  FROM _listing_map m JOIN order_items oi ON oi.shop_product_id = m.sp_id
 WHERE r.order_id = oi.order_id AND r.product_id = m.old_pid;

-- Original catalog entries with no seller listing become admin listings on the platform shop
INSERT INTO shop_products (shop_id, product_id, price, sale_price, mrp, stock_quantity, low_stock_threshold, max_order_qty, is_available,
                           approval_status, approved_at, seller_sku, min_order_qty, handling_time_days, cod_eligible,
                           nationwide_shipping_enabled, local_delivery_enabled, listing_status, sold_count)
SELECT (SELECT id FROM shops WHERE is_platform = true), p.id, COALESCE(p.sale_price, p.price), COALESCE(p.sale_price, p.price), p.price,
       COALESCE(p.stock_quantity, 0), COALESCE(p.low_stock_threshold, 10), 10, COALESCE(p.stock_quantity, 0) > 0, 'APPROVED', NOW(), p.sku, 1, 1,
       true, true, true, CASE WHEN COALESCE(p.stock_quantity, 0) > 0 THEN 'ACTIVE' ELSE 'OUT_OF_STOCK' END, COALESCE(p.total_sold, 0)
  FROM products p
 WHERE p.owner_type = 'ADMIN' AND p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM shop_products sp WHERE sp.product_id = p.id);

UPDATE products SET warranty_info = '1 year manufacturer warranty', accessories_included = 'Original box and accessories'
 WHERE owner_type = 'ADMIN' AND warranty_info IS NULL;
