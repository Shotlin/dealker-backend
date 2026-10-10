-- Electronics-only catalogue cleanup + 50-product seed (admin / vendor / dealer owners).
-- Run with: psql -v finish=ROLLBACK -f this.sql   (dry run)   |   -v finish=COMMIT
-- Soft-delete only: products/shop_products get deleted_at, categories deleted_at + inactive,
-- non-electronics vendors/shops are deactivated. Nothing is hard-deleted. Dealers are modelled as vendors.
BEGIN;

-- 1. SOFT-DELETE non-electronics products and their listings
WITH bad AS (
  SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
  WHERE c.name <> 'Electronics' AND p.deleted_at IS NULL
), p AS (
  UPDATE products SET deleted_at = NOW(), is_active = false, updated_at = NOW() WHERE id IN (SELECT id FROM bad) RETURNING 1
), sp AS (
  UPDATE shop_products SET deleted_at = NOW(), is_available = false, listing_status = 'PAUSED', updated_at = NOW()
  WHERE product_id IN (SELECT id FROM bad) AND deleted_at IS NULL RETURNING 1
)
SELECT (SELECT count(*) FROM p) AS products_soft_deleted, (SELECT count(*) FROM sp) AS listings_soft_deleted;

-- 2. Non-electronics categories off
UPDATE categories SET is_active = false, deleted_at = NOW(), updated_at = NOW()
WHERE name <> 'Electronics' AND parent_id IS NULL AND deleted_at IS NULL;

-- 3. Vendors that now have no live product -> deactivated (reversible, not deleted)
WITH dead AS (
  SELECT v.id FROM vendors v
  WHERE v.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_vendor_id = v.id AND p.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM products p WHERE p.owner_vendor_id = v.id)
), v AS (
  UPDATE vendors SET status = 'DEACTIVATED', is_active = false, updated_at = NOW() WHERE id IN (SELECT id FROM dead) RETURNING id
)
UPDATE shops SET is_active = false, updated_at = NOW() WHERE vendor_id IN (SELECT id FROM v);

-- 4. Two dealers (vendor type = dealer)
INSERT INTO vendors (name, slug, email, phone, status, is_active)
VALUES ('Sharma Mobile Dealers', 'sharma-mobile-dealers', 'sales@sharmamobiledealers.in', '9830011001', 'ACTIVE', true),
       ('Metro Telecom Dealers', 'metro-telecom-dealers', 'orders@metrotelecomdealers.in', '9830011002', 'ACTIVE', true)
ON CONFLICT DO NOTHING;

INSERT INTO shops (name, slug, branch_code, description, phone, email, address_line1, city, state, pincode, lat, lng,
                   delivery_radius_km, is_active, is_verified, commission_rate, order_prefix, vendor_id, pickup_capable, warehouse_status)
SELECT 'Sharma Mobile Dealers', 'sharma-mobile-dealers-shop', 'DLR001', 'Authorised multi-brand mobile dealer — bulk and retail',
       '9830011001', 'sales@sharmamobiledealers.in', '24, Chandni Chowk Market', 'Kolkata', 'West Bengal', '700013', 22.57264, 88.36389,
       25, true, true, 8, 'DLR1', v.id, true, 'OPERATIONAL' FROM vendors v WHERE v.slug = 'sharma-mobile-dealers'
  AND NOT EXISTS (SELECT 1 FROM shops s WHERE s.vendor_id = v.id);
INSERT INTO shops (name, slug, branch_code, description, phone, email, address_line1, city, state, pincode, lat, lng,
                   delivery_radius_km, is_active, is_verified, commission_rate, order_prefix, vendor_id, pickup_capable, warehouse_status)
SELECT 'Metro Telecom Dealers', 'metro-telecom-dealers-shop', 'DLR002', 'Multi-brand telecom and accessories dealer',
       '9830011002', 'orders@metrotelecomdealers.in', '81, Nehru Place', 'New Delhi', 'Delhi', '110019', 28.54910, 77.25310,
       25, true, true, 8, 'DLR2', v.id, true, 'OPERATIONAL' FROM vendors v WHERE v.slug = 'metro-telecom-dealers'
  AND NOT EXISTS (SELECT 1 FROM shops s WHERE s.vendor_id = v.id);

-- 5. 50 new electronics models. owner: ADM=admin(platform), TN, GG, MM, TF, RN, CM = vendors, D1/D2 = dealers
CREATE TEMP TABLE new_items (n serial, name text, brand text, mrp int, price int, owner text, cond text, stock int, hsn text, kind text);
INSERT INTO new_items (name, brand, mrp, price, owner, cond, stock, hsn, kind) VALUES
('Apple iPhone 15 Pro (256GB, Natural Titanium)','Apple',134900,127900,'ADM','NEW',30,'8517','phone'),
('Apple iPhone 16 (128GB, Black)','Apple',79900,74900,'ADM','NEW',40,'8517','phone'),
('Apple iPhone 16 Pro Max (256GB, Desert Titanium)','Apple',144900,139900,'D1','NEW',12,'8517','phone'),
('Apple iPhone 14 (128GB, Midnight)','Apple',69900,52999,'TN','NEW',18,'8517','phone'),
('Apple iPhone 13 (128GB, Starlight)','Apple',59900,38500,'RN','REFURBISHED',3,'8517','phone'),
('Apple iPhone 12 (64GB, Blue)','Apple',59900,24999,'CM','USED_GOOD',1,'8517','phone'),
('Samsung Galaxy S24 Ultra 5G (12GB/256GB, Titanium Gray)','Samsung',129999,109999,'ADM','NEW',25,'8517','phone'),
('Samsung Galaxy S24 5G (8GB/128GB, Onyx Black)','Samsung',79999,62999,'D1','NEW',20,'8517','phone'),
('Samsung Galaxy S23 FE 5G (8GB/128GB, Mint)','Samsung',59999,34999,'GG','NEW',14,'8517','phone'),
('Samsung Galaxy A55 5G (8GB/128GB, Awesome Navy)','Samsung',39999,29999,'ADM','NEW',50,'8517','phone'),
('Samsung Galaxy A35 5G (8GB/128GB, Awesome Iceblue)','Samsung',30999,24999,'MM','NEW',35,'8517','phone'),
('Samsung Galaxy M35 5G (6GB/128GB, Moonlight Blue)','Samsung',24999,16999,'MM','NEW',60,'8517','phone'),
('Samsung Galaxy Z Flip5 (8GB/256GB, Mint)','Samsung',99999,54999,'RN','REFURBISHED',2,'8517','phone'),
('Redmi Note 13 Pro+ 5G (8GB/256GB, Fusion Purple)','Redmi',37999,29999,'ADM','NEW',45,'8517','phone'),
('Redmi Note 13 5G (6GB/128GB, Arctic White)','Redmi',18999,15999,'TF','NEW',55,'8517','phone'),
('Redmi 13C 5G (4GB/128GB, Starlight Black)','Redmi',12999,9999,'CM','NEW',70,'8517','phone'),
('Redmi A3 (3GB/64GB, Midnight Black)','Redmi',8999,6799,'D2','NEW',90,'8517','phone'),
('Redmi 13 5G (6GB/128GB, Orchid Pink)','Redmi',15999,12999,'D2','NEW',65,'8517','phone'),
('Xiaomi 14 Civi 5G (8GB/256GB, Shadow Black)','Xiaomi',42999,39999,'ADM','NEW',16,'8517','phone'),
('POCO X6 Pro 5G (8GB/256GB, Yellow)','POCO',26999,21999,'TN','NEW',40,'8517','phone'),
('POCO M6 Pro 5G (6GB/128GB, Forest Green)','POCO',14999,10999,'MM','NEW',60,'8517','phone'),
('OnePlus 12 5G (12GB/256GB, Silky Black)','OnePlus',69999,62999,'ADM','NEW',22,'8517','phone'),
('OnePlus Nord CE4 5G (8GB/128GB, Celadon Marble)','OnePlus',26999,24999,'GG','NEW',33,'8517','phone'),
('OnePlus 11 5G (8GB/128GB, Titan Black)','OnePlus',56999,31999,'GG','USED_LIKE_NEW',1,'8517','phone'),
('realme 12 Pro+ 5G (8GB/256GB, Submarine Blue)','realme',33999,29999,'D1','NEW',28,'8517','phone'),
('realme Narzo 70x 5G (4GB/128GB, Forest Green)','realme',13999,10999,'CM','NEW',75,'8517','phone'),
('Vivo V30 5G (8GB/256GB, Andaman Blue)','Vivo',36999,33999,'TN','NEW',24,'8517','phone'),
('Vivo T3 5G (8GB/128GB, Cosmic Blue)','Vivo',21999,17999,'D2','NEW',48,'8517','phone'),
('OPPO Reno11 5G (8GB/128GB, Wave Green)','OPPO',29999,26999,'TF','NEW',26,'8517','phone'),
('Motorola Edge 50 Fusion 5G (8GB/128GB, Forest Blue)','Motorola',24999,20999,'MM','NEW',38,'8517','phone'),
('Google Pixel 8a (8GB/128GB, Obsidian)','Google',52999,46999,'ADM','NEW',15,'8517','phone'),
('Nothing Phone (2a) 5G (8GB/128GB, Black)','Nothing',23999,21999,'TN','NEW',30,'8517','phone'),
('Apple AirPods Pro (2nd Gen, USB-C)','Apple',26900,22900,'ADM','NEW',60,'8518','audio'),
('Apple AirPods (3rd Gen)','Apple',20900,16999,'D1','NEW',35,'8518','audio'),
('Samsung Galaxy Buds2 Pro','Samsung',17999,9999,'GG','NEW',40,'8518','audio'),
('Sony WH-1000XM5 Wireless Noise Cancelling Headphones','Sony',34990,26990,'ADM','NEW',20,'8518','audio'),
('JBL Tune 770NC Wireless Headphones','JBL',8999,5499,'TN','NEW',45,'8518','audio'),
('boAt Airdopes 141 TWS Earbuds','boAt',4490,1099,'MM','NEW',150,'8518','audio'),
('OnePlus Nord Buds 2 TWS Earbuds','OnePlus',2999,2299,'D2','NEW',80,'8518','audio'),
('realme Buds T300 TWS Earbuds','realme',3499,2199,'CM','NEW',90,'8518','audio'),
('Redmi Buds 5 TWS Earbuds','Redmi',3999,2499,'TF','NEW',85,'8518','audio'),
('JBL Flip 6 Portable Bluetooth Speaker','JBL',11999,8999,'ADM','NEW',32,'8518','audio'),
('Apple Watch Series 9 GPS 41mm','Apple',41900,32999,'D1','NEW',14,'8517','watch'),
('Samsung Galaxy Watch6 Classic 47mm','Samsung',36999,21999,'GG','NEW',18,'8517','watch'),
('Fire-Boltt Ninja Call Pro Plus Smartwatch','Fire-Boltt',8999,1299,'MM','NEW',200,'8517','watch'),
('Apple 20W USB-C Power Adapter','Apple',1900,1599,'ADM','NEW',100,'8504','acc'),
('Samsung 25W Super Fast Charger (USB-C)','Samsung',1999,1199,'TN','NEW',110,'8504','acc'),
('Anker PowerCore 20000mAh Power Bank','Anker',4999,2999,'D2','NEW',70,'8507','acc'),
('Spigen Ultra Hybrid Case for iPhone 15','Spigen',2499,1199,'CM','NEW',120,'3926','acc'),
('Samsung T7 Shield 1TB Portable SSD','Samsung',14999,9999,'ADM','NEW',40,'8471','acc');

CREATE TEMP TABLE owners AS
  SELECT 'ADM' k, NULL::uuid vid, (SELECT id FROM shops WHERE is_platform = true LIMIT 1) sid
  UNION ALL SELECT 'TN', 'c346ded0-3d3d-48cd-a3b6-6d2c5604d81e', (SELECT id FROM shops WHERE vendor_id='c346ded0-3d3d-48cd-a3b6-6d2c5604d81e')
  UNION ALL SELECT 'GG', '934d5ef6-ffc7-4463-97a1-0b1781408279', (SELECT id FROM shops WHERE vendor_id='934d5ef6-ffc7-4463-97a1-0b1781408279')
  UNION ALL SELECT 'MM', '08ce5f7f-d08c-44e8-9657-1d4bfe9469ea', (SELECT id FROM shops WHERE vendor_id='08ce5f7f-d08c-44e8-9657-1d4bfe9469ea')
  UNION ALL SELECT 'TF', '68913b2f-7039-40db-80b0-6bdd5962b798', (SELECT id FROM shops WHERE vendor_id='68913b2f-7039-40db-80b0-6bdd5962b798')
  UNION ALL SELECT 'RN', '0c3ef9ce-7e96-4442-a349-12b7dfcad73f', (SELECT id FROM shops WHERE vendor_id='0c3ef9ce-7e96-4442-a349-12b7dfcad73f')
  UNION ALL SELECT 'CM', '4e8e47a4-9ebf-4c4f-9727-e65346d613ed', (SELECT id FROM shops WHERE vendor_id='4e8e47a4-9ebf-4c4f-9727-e65346d613ed')
  UNION ALL SELECT 'D1', v.id, (SELECT id FROM shops WHERE vendor_id=v.id) FROM vendors v WHERE v.slug='sharma-mobile-dealers'
  UNION ALL SELECT 'D2', v.id, (SELECT id FROM shops WHERE vendor_id=v.id) FROM vendors v WHERE v.slug='metro-telecom-dealers';

CREATE TEMP TABLE ins (pid uuid, sid uuid, n int);
WITH rows AS (
  SELECT i.*, o.vid, o.sid, gen_random_uuid() pid FROM new_items i JOIN owners o ON o.k = i.owner
), p AS (
  INSERT INTO products (id, name, slug, description, price, sale_price, category_id, stock_quantity, unit, thumbnail_url, images, is_active, sku,
      max_order_qty, brand, avg_rating, rating_count, is_authentic, return_policy, return_policy_days, hsn_code, gst_rate, specifications,
      owner_type, owner_vendor_id, condition, condition_notes, usage_duration, warranty_info, accessories_included, battery_health, has_invoice, total_sold)
  SELECT r.pid, r.name, trim(both '-' from lower(regexp_replace(r.name, '[^a-zA-Z0-9]+', '-', 'g'))) || '-' || substr(r.pid::text, 1, 6),
         r.name || ' — genuine ' || r.brand || ' ' || CASE r.kind WHEN 'phone' THEN 'smartphone' WHEN 'audio' THEN 'audio product' WHEN 'watch' THEN 'smartwatch' ELSE 'accessory' END || ' with GST invoice.',
         r.mrp, r.price, (SELECT id FROM categories WHERE name='Electronics'), r.stock, 'pc',
         'https://picsum.photos/seed/' || substr(r.pid::text,1,8) || '-1/600/600',
         jsonb_build_array('https://picsum.photos/seed/' || substr(r.pid::text,1,8) || '-1/600/600','https://picsum.photos/seed/' || substr(r.pid::text,1,8) || '-2/600/600','https://picsum.photos/seed/' || substr(r.pid::text,1,8) || '-3/600/600'),
         true, upper(left(regexp_replace(r.brand,'[^a-zA-Z]','','g'),4)) || '-' || lpad((1000 + r.n)::text, 5, '0'),
         CASE WHEN r.cond = 'NEW' THEN 5 ELSE 1 END, r.brand,
         round((4.0 + (r.n % 9) / 10.0)::numeric, 1), 20 + (r.n * 37) % 400, true,
         CASE WHEN r.cond = 'NEW' THEN '7_day' ELSE 'no_return' END, CASE WHEN r.cond = 'NEW' THEN 7 ELSE 0 END,
         r.hsn, 18, jsonb_build_object('Brand', r.brand, 'Type', r.kind, 'Model', r.name),
         CASE WHEN r.vid IS NULL THEN 'ADMIN' ELSE 'VENDOR' END, r.vid, r.cond,
         CASE r.cond WHEN 'USED_GOOD' THEN 'Fully working. Light scratches on body, no cracks.' WHEN 'USED_LIKE_NEW' THEN 'Barely used, no marks. Original accessories included.'
                     WHEN 'REFURBISHED' THEN 'Professionally refurbished and tested. Seller warranty included.' END,
         CASE r.cond WHEN 'USED_GOOD' THEN '10 months' WHEN 'USED_LIKE_NEW' THEN '4 months' END,
         CASE r.cond WHEN 'NEW' THEN '1 year manufacturer warranty' WHEN 'REFURBISHED' THEN '6 months seller warranty' ELSE '1 month seller warranty' END,
         CASE WHEN r.kind IN ('phone') THEN 'Original box, charger cable and documents' ELSE 'Original box and accessories' END,
         CASE WHEN r.kind = 'phone' AND r.cond <> 'NEW' THEN 85 + r.n % 12 END, true, (r.n * 13) % 180
  FROM rows r RETURNING id
), sp AS (
  INSERT INTO shop_products (shop_id, product_id, price, sale_price, mrp, stock_quantity, low_stock_threshold, max_order_qty, is_available, approval_status, approved_at,
      seller_sku, min_order_qty, handling_time_days, cod_eligible, nationwide_shipping_enabled, local_delivery_enabled, listing_status, qc_status, qc_mode, sell_b2c, sell_b2b)
  SELECT r.sid, r.pid, r.price, r.price, r.mrp, r.stock, 2, CASE WHEN r.cond = 'NEW' THEN 5 ELSE 1 END, true, 'APPROVED', NOW(),
         upper(left(regexp_replace(r.brand,'[^a-zA-Z]','','g'),4)) || '-' || lpad((1000 + r.n)::text, 5, '0'), 1, 2, r.price < 50000, true, true, 'ACTIVE', 'QC_PASSED', 'MANUAL', true, r.owner IN ('D1','D2')
  FROM rows r RETURNING 1
)
SELECT (SELECT count(*) FROM p) AS products_added, (SELECT count(*) FROM sp) AS listings_added;

-- 6. Verification inside the transaction
SELECT c.name cat, p.owner_type, count(*) FROM products p JOIN categories c ON c.id = p.category_id WHERE p.deleted_at IS NULL AND p.is_active GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) AS live_active_products FROM products WHERE deleted_at IS NULL AND is_active;
SELECT count(*) AS live_vendors FROM vendors WHERE is_active AND deleted_at IS NULL;

:finish;
