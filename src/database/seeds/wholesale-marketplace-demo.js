/**
 * Demo data for the B2B Marketplace (vendor app "B2B Marketplace" + dashboard "Wholesale shelf").
 *
 *   node src/database/seeds/wholesale-marketplace-demo.js --dry-run   print the plan, write nothing
 *   node src/database/seeds/wholesale-marketplace-demo.js             add vendors, categories, listings (idempotent)
 *   node src/database/seeds/wholesale-marketplace-demo.js --clear     remove ONLY what this script created
 *
 * Four wholesale distributors (verified, with profile + GSTIN-format ids + a demo wallet balance) list 26 new
 * products on both channels (retail price + wholesale price, MOQ, stock, optional B2B discount). Listings go
 * through the real listing service (admin listing on behalf of a vendor → approved + live at once). Photos are
 * served from UPLOAD_BASE_URL (default: the demo server's /uploads/products/wholesale/).
 *
 * Tagged and removable: vendors.slug 'ws-demo-%' · users with the four phones below · products.sku 'WS-%'.
 * The GSTINs / PANs / addresses are demo placeholders (valid format, not real registrations).
 * Login: the phones must be in DEMO_OTP_PHONES (OTP 123456) — see the deploy notes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { query, pool } = await import('../../config/database.js')
const { listingsService } = await import('../../modules/listings/listings.service.js')

const DRY = process.argv.includes('--dry-run')
const CLEAR = process.argv.includes('--clear')
const here = dirname(fileURLToPath(import.meta.url))
const PRODUCTS = JSON.parse(readFileSync(join(here, 'wholesale-demo-products.json'), 'utf8'))
const IMG_BASE = (process.env.UPLOAD_BASE_URL || 'https://api.dealker.agnixstudio.in/uploads/products/wholesale').replace(/\/$/, '')

const VENDORS = [
  { name: 'Sai Ram Mobile Distributors', owner: 'Venkat Reddy', legal: 'Sai Ram Mobile Distributors Pvt Ltd', city: 'Hyderabad', state: 'Telangana', code: '36', pin: '500003',
    line: '6-1-72, Sarojini Devi Road, Secunderabad', lat: 17.4399, lng: 78.4983, rating: 4.7, reviews: 312, phone: '9700020101', pan: 'AABCS4521K', topup: 500000 },
  { name: 'Mehta Telecom Wholesale', owner: 'Hitesh Mehta', legal: 'Mehta Telecom Wholesale LLP', city: 'Ahmedabad', state: 'Gujarat', code: '24', pin: '380009',
    line: '14, Navrangpura Commercial Hub, CG Road', lat: 23.0395, lng: 72.5660, rating: 4.6, reviews: 204, phone: '9700020102', pan: 'AAFFM7783H', topup: 500000 },
  { name: 'Kolkata Gadget Mart', owner: 'Subrata Das', legal: 'Kolkata Gadget Mart Pvt Ltd', city: 'Kolkata', state: 'West Bengal', code: '19', pin: '700013',
    line: '27, Chandni Chowk Market, Central Avenue', lat: 22.5726, lng: 88.3639, rating: 4.5, reviews: 158, phone: '9700020103', pan: 'AAGCK3310M', topup: 500000 },
  { name: 'Jaipur Digital Traders', owner: 'Rakesh Agarwal', legal: 'Jaipur Digital Traders', city: 'Jaipur', state: 'Rajasthan', code: '08', pin: '302001',
    line: 'Shop 41, Johari Bazar Electronics Plaza, MI Road', lat: 26.9124, lng: 75.7873, rating: 4.8, reviews: 276, phone: '9700020104', pan: 'AAAPA9047D', topup: 500000 },
]

// Parent → children. Parents already exist on the live catalog; created here only when missing (scratch DBs).
const TREE = {
  'Mobiles & Tablets': ['Apple iPhone', 'Samsung Galaxy', 'OnePlus', 'Xiaomi & Redmi', 'realme', 'Vivo & iQOO', 'Other Android', 'Tablets'],
  'Headphones & Earbuds': ['True Wireless Earbuds'],
  'Chargers & Power Banks': ['Power Banks', 'Chargers & Adapters'],
  'Smart Watches': [],
}
const HSN = { 'Chargers & Adapters': '8504', 'Power Banks': '8507', 'True Wireless Earbuds': '8518', 'Smart Watches': '9102' }
const slugify = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

/** GSTIN = 2-digit state + PAN + entity no. + 'Z' + check character (mod-36 checksum). */
function gstin(stateCode, pan, entity = '1') {
  const base = `${stateCode}${pan}${entity}Z`
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let sum = 0
  for (let i = 0; i < base.length; i++) {
    const v = chars.indexOf(base[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(v / 36) + (v % 36)
  }
  return base + chars[(36 - (sum % 36)) % 36]
}

async function clear() {
  const { rows: ps } = await query(`SELECT id FROM products WHERE sku LIKE 'WS-%'`)
  for (const p of ps) {
    await query(`DELETE FROM shop_products WHERE product_id = $1`, [p.id])
    await query(`DELETE FROM products WHERE id = $1`, [p.id])
  }
  const { rows: vs } = await query(`SELECT id FROM vendors WHERE slug LIKE 'ws-demo-%'`)
  const ids = vs.map((v) => v.id)
  if (ids.length) {
    await query(`DELETE FROM settlement_ledger WHERE vendor_id = ANY($1)`, [ids])
    await query(`DELETE FROM vendor_profiles WHERE vendor_id = ANY($1)`, [ids])
    await query(`DELETE FROM vendor_users WHERE vendor_id = ANY($1)`, [ids])
    await query(`DELETE FROM shops WHERE vendor_id = ANY($1)`, [ids])
    await query(`DELETE FROM vendors WHERE id = ANY($1)`, [ids])
  }
  await query(`DELETE FROM users WHERE phone = ANY($1)`, [VENDORS.map((v) => v.phone)])
  console.log(`cleared ${ps.length} listings, ${ids.length} vendors (categories are left in place)`)
}

async function ensureCategories() {
  const ids = {}
  let order = 100
  for (const [parent, kids] of Object.entries(TREE)) {
    const pslug = slugify(parent)
    let { rows } = await query(`SELECT id FROM categories WHERE slug = $1 OR name = $2 ORDER BY (slug = $1) DESC LIMIT 1`, [pslug, parent])
    if (!rows[0] && !DRY) rows = (await query(`INSERT INTO categories (name, slug, sort_order, is_active) VALUES ($1,$2,$3,TRUE) RETURNING id`, [parent, pslug, order])).rows
    ids[parent] = rows[0]?.id
    for (const [i, kid] of kids.entries()) {
      const kslug = `${pslug}-${slugify(kid)}`
      let r = (await query(`SELECT id FROM categories WHERE slug = $1`, [kslug])).rows
      if (!r[0] && !DRY) r = (await query(`INSERT INTO categories (name, slug, parent_id, sort_order, is_active) VALUES ($1,$2,$3,$4,TRUE) RETURNING id`, [kid, kslug, ids[parent], i + 1])).rows
      ids[kid] = r[0]?.id
    }
    order++
  }
  return ids
}

async function ensureVendor(v, i) {
  const slug = `ws-demo-${slugify(v.name)}`
  const { rows: ex } = await query('SELECT id FROM vendors WHERE slug = $1', [slug])
  if (DRY) return ex[0]?.id || `(new vendor ${v.name})`
  const { rows: u0 } = await query('SELECT id, name FROM users WHERE phone = $1', [v.phone])
  if (u0[0] && !ex[0]) throw new Error(`Phone ${v.phone} already belongs to another user — aborting`)
  const userId = u0[0]?.id || (await query(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, [v.phone, v.owner])).rows[0].id
  const vendorId = ex[0]?.id || (await query(
    `INSERT INTO vendors (name, slug, email, phone, status, is_active) VALUES ($1,$2,$3,$4,'ACTIVE',TRUE) RETURNING id`,
    [v.name, slug, `accounts@${slug.replace('ws-demo-', '')}.demo.dealker.local`, v.phone])).rows[0].id
  await query(`UPDATE vendors SET avg_rating = $2, review_count = $3 WHERE id = $1`, [vendorId, v.rating, v.reviews])
  await query(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER') ON CONFLICT DO NOTHING`, [vendorId, userId])
  if (!(await query(`SELECT 1 FROM shops WHERE vendor_id = $1`, [vendorId])).rows[0]) {
    await query(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, seller_rating, rating_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [`${v.name} — ${v.city}`, `${slug}-shop`, `WS-V${i + 1}`, v.line, v.city, v.state, v.pin, v.lat, v.lng, vendorId, v.rating, v.reviews])
  }
  await query(
    `INSERT INTO vendor_profiles (vendor_id, legal_name, gstin, pan_number, address_line1, city, state, pincode, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (vendor_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, pan_number = EXCLUDED.pan_number,
       address_line1 = EXCLUDED.address_line1, city = EXCLUDED.city, state = EXCLUDED.state, pincode = EXCLUDED.pincode,
       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = NOW()`,
    [vendorId, v.legal, gstin(v.code, v.pan), v.pan, v.line, v.city, v.state, v.pin, v.lat, v.lng])
  // Demo wallet balance, so these accounts can pay for wholesale orders when testing the buyer side.
  await query(
    `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, idempotency_key)
     VALUES ($1,'ADJUSTMENT',$2,$2,'Demo wallet top-up',$3) ON CONFLICT DO NOTHING`, [vendorId, v.topup, `ws-demo-topup:${vendorId}`])
  return vendorId
}

const mrpFor = (retail) => Math.ceil((retail * 1.12) / 100) * 100 - 1

async function main() {
  if (CLEAR) { await clear(); return }
  const { rows: adm } = await query(`SELECT id FROM users WHERE role = 'ADMIN' AND is_active = TRUE ORDER BY created_at LIMIT 1`)
  const cats = await ensureCategories()
  const vendorIds = []
  for (let i = 0; i < VENDORS.length; i++) vendorIds.push(await ensureVendor(VENDORS[i], i))
  console.log(`${VENDORS.length} vendors ready, ${Object.keys(cats).length} categories ready`)

  let made = 0
  for (let n = 0; n < PRODUCTS.length; n++) {
    const p = PRODUCTS[n]
    const sku = `WS-${String(n + 1).padStart(3, '0')}`
    if ((await query(`SELECT 1 FROM products WHERE sku = $1`, [sku])).rows[0]) continue
    const categoryId = cats[p.cat]
    if (!categoryId && !DRY) throw new Error(`No category for ${p.cat}`)
    // Photos are uploaded to IMG_BASE as <key>-1.jpg …; listings need at least 3, so a short set repeats its main photo.
    const shown = Array.from({ length: Math.max(3, p.imgs || 3) }, (_, k) => `${IMG_BASE}/${p.key}-${k < (p.imgs || 1) ? k + 1 : 1}.jpg`)
    console.log(`  ${sku} ${p.name} · ${VENDORS[p.vendor].name} · retail ₹${p.retail} · wholesale ₹${p.wholesale} · MOQ ${p.moq} · stock ${p.stock}${p.discount ? ` · ${p.discount}% deal` : ''}`)
    if (DRY) continue
    await listingsService.create({
      name: p.name, categoryId, brand: p.brand, ownerVendorId: vendorIds[p.vendor], condition: 'NEW', stock: p.stock,
      price: p.retail, mrp: mrpFor(p.retail), images: shown, sku, sellB2c: true, sellB2b: true,
      wholesalePrice: p.wholesale, moq: p.moq, b2bDiscountPct: p.discount ?? null,
      b2bNotes: 'Bulk dispatch in 2–3 working days. GST invoice on every order. Sealed brand-new stock.',
      description: `${p.name} — brand-new, sealed stock available in wholesale lots with a GST invoice.`,
      specifications: p.specs || {}, hsnCode: HSN[p.cat] || '8517', gstRate: 18, warrantyInfo: '1 year manufacturer warranty',
      returnPolicyDays: 7, hasInvoice: true, handlingTimeDays: 2,
    }, { vendorId: null, actorId: adm[0]?.id })
    made++
  }
  console.log(`done: ${made} listings created`)
}

try { await main() } finally { await pool.end() }
