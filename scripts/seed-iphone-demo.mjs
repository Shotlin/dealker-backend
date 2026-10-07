// Demo: the same model (iPhone 15) listed separately by admin and several vendors, each with own photos/condition/price.
import 'dotenv/config'
import pg from 'pg'
const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD })
const rows = [
  // owner (vendor name or null=admin), condition, price, mrp, notes, usage, battery, stock
  [null, 'NEW', 69900, 79900, null, null, null, 25],
  ['TechNest Retail', 'USED_GOOD', 30000, 79900, 'Light scratches on the frame, screen is spotless. Original charger included.', '8 months', 88, 1],
  ['Gadget Galaxy', 'USED_LIKE_NEW', 32000, 79900, 'Used for 3 months with case and screen guard. No marks at all.', '3 months', 94, 1],
  ['TechNest Retail', 'REFURBISHED', 41999, 79900, 'Professionally refurbished with new battery and fresh body. 6-month seller warranty.', 'Refurbished', 100, 2],
  ['Gadget Galaxy', 'USED_FAIR', 26500, 79900, 'Visible scratches on back glass, small dent at corner. Works perfectly.', '18 months', 82, 1],
]
const c = await pool.connect()
try {
  await c.query('BEGIN')
  if ((await c.query(`SELECT 1 FROM products WHERE name LIKE 'Apple iPhone 15%' LIMIT 1`)).rows[0]) { console.log('already seeded'); process.exit(0) }
  const cat = (await c.query(`SELECT id FROM categories WHERE name='Electronics'`)).rows[0].id
  const platform = (await c.query(`SELECT id FROM shops WHERE is_platform = true`)).rows[0].id
  let n = 0
  for (const [vname, cond, price, mrp, notes, usage, battery, stock] of rows) {
    n++
    let shop = platform; let vid = null
    if (vname) { const r = (await c.query(`SELECT s.id, s.vendor_id FROM shops s JOIN vendors v ON v.id=s.vendor_id WHERE v.name=$1`, [vname])).rows[0]; shop = r.id; vid = r.vendor_id }
    const seed = `iphone15-${n}`
    const imgs = [1, 2, 3, 4].map((i) => `https://picsum.photos/seed/${seed}-${i}/600/600`)
    const pid = (await c.query(
      `INSERT INTO products (name, slug, description, price, sale_price, category_id, stock_quantity, unit, thumbnail_url, images, is_active, sku, brand, hsn_code, gst_rate,
         return_policy_days, owner_type, owner_vendor_id, condition, condition_notes, usage_duration, warranty_info, accessories_included, battery_health, has_invoice, max_order_qty,
         specifications)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pc',$8,$9,true,$10,'Apple','8517',18,7,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      ['Apple iPhone 15 (128GB, Blue)', `apple-iphone-15-128gb-blue-${n}`, 'Apple iPhone 15 with A16 Bionic chip, 48MP main camera and USB-C.', mrp, price, cat, stock, imgs[0], JSON.stringify(imgs),
        `IP15-${n}00`, vname ? 'VENDOR' : 'ADMIN', vid, cond, notes, usage, cond === 'NEW' ? '1 year Apple warranty' : cond === 'REFURBISHED' ? '6 months seller warranty' : '1 month seller warranty',
        cond === 'USED_FAIR' ? 'Phone only' : 'Charger cable included', battery, cond !== 'USED_FAIR', cond.startsWith('USED') ? 1 : 10,
        JSON.stringify({ Storage: '128 GB', Colour: 'Blue', Display: '6.1-inch Super Retina XDR', Chip: 'A16 Bionic' })])).rows[0].id
    await c.query(
      `INSERT INTO shop_products (shop_id, product_id, price, sale_price, mrp, stock_quantity, low_stock_threshold, max_order_qty, is_available, approval_status, approved_at, seller_sku,
         min_order_qty, handling_time_days, cod_eligible, nationwide_shipping_enabled, local_delivery_enabled, listing_status)
       VALUES ($1,$2,$3,$3,$4,$5,1,$6,true,'APPROVED',NOW(),$7,1,2,true,true,true,'ACTIVE')`, [shop, pid, price, mrp, stock, cond.startsWith('USED') ? 1 : 10, `IP15-${n}00`])
  }
  await c.query('COMMIT'); console.log('iPhone 15 demo listings added:', rows.length)
} catch (e) { await c.query('ROLLBACK'); console.error(e.message); process.exitCode = 1 } finally { c.release(); await pool.end() }
