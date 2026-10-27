/**
 * Demo second-hand devices with QC reports (so the product page / QC report UI has real-looking data).
 *
 *   node src/database/seeds/used-devices-demo.js --dry-run   print the plan, write nothing
 *   node src/database/seeds/used-devices-demo.js             add vendors + listings (idempotent)
 *   node src/database/seeds/used-devices-demo.js --clear     remove ONLY what this script created
 *
 * Goes through the real listing service (admin listing on behalf of a vendor → live immediately) and the
 * real QC service (manual inspection with score + per-check results). Photos are the real photos already
 * stored for the same model in the platform catalog. Tagged and removable:
 *   vendors.slug 'used-demo-%' · users.name '… (owner)' with phones 90000001xx · products.sku 'UD-%'
 */

const { query, pool } = await import('../../config/database.js')
const { listingsService } = await import('../../modules/listings/listings.service.js')
const { QcService } = await import('../../modules/qc/qc.service.js')

const DRY = process.argv.includes('--dry-run')
const CLEAR = process.argv.includes('--clear')

const VENDORS = [
  { name: 'Second Mobile Store', city: 'Mumbai', state: 'Maharashtra', pin: '400053', lat: 19.1197, lng: 72.8468, rating: 4.7, reviews: 214, phone: '9700010101' },
  { name: 'Gizmo Exchange', city: 'Bengaluru', state: 'Karnataka', pin: '560034', lat: 12.9352, lng: 77.6245, rating: 4.5, reviews: 168, phone: '9700010102' },
  { name: 'ReBoot Gadgets', city: 'Chennai', state: 'Tamil Nadu', pin: '600017', lat: 13.0418, lng: 80.2341, rating: 4.4, reviews: 97, phone: '9700010103' },
  { name: 'Delhi Device Depot', city: 'New Delhi', state: 'Delhi', pin: '110019', lat: 28.5494, lng: 77.2501, rating: 4.6, reviews: 132, phone: '9700010104' },
]

const GRADE = {
  USED_LIKE_NEW: { score: [93, 97], usage: ['3 months', '5 months', '6 months'], warranty: '6 months seller warranty', pct: 0.8 },
  USED_GOOD: { score: [85, 91], usage: ['9 months', '11 months', '14 months'], warranty: '3 months seller warranty', pct: 0.68 },
  USED_FAIR: { score: [77, 83], usage: ['20 months', '26 months', '30 months'], warranty: '1 month seller warranty', pct: 0.55 },
  OPEN_BOX: { score: [95, 98], usage: ['Unused, box opened'], warranty: '12 months brand warranty', pct: 0.9 },
  REFURBISHED: { score: [90, 95], usage: ['Refurbished by seller'], warranty: '6 months seller warranty', pct: 0.74 },
}

const SKIN = {
  USED_LIKE_NEW: ['No scratches', 'Flawless', 'Barely visible marks'],
  USED_GOOD: ['Light hairline marks', 'Minor scuffs on frame', 'Small marks, no dents'],
  USED_FAIR: ['Visible scratches on body', 'Scuffed frame, small dent on corner', 'Clear wear marks'],
  OPEN_BOX: ['Brand new, no marks', 'Unused, seal opened only', 'Flawless'],
  REFURBISHED: ['Fresh housing, like new', 'Replaced back panel', 'Cosmetically restored'],
}

// [catalog name, MRP-ish new price, condition, vendor index, kind]
const PLAN = [
  ['Apple iPhone 14 (128GB, Midnight)', 69900, 'USED_LIKE_NEW', 0, 'phone'],
  ['Apple iPhone 14 (128GB, Midnight)', 69900, 'USED_GOOD', 3, 'phone'],
  ['Apple iPhone 15 (128GB, Blue)', 79900, 'USED_GOOD', 1, 'phone'],
  ['Apple iPhone 13 (128GB, Starlight)', 59900, 'REFURBISHED', 2, 'phone'],
  ['Apple iPhone 12 (64GB, Blue)', 49900, 'USED_FAIR', 3, 'phone'],
  ['OnePlus 12 5G (12GB/256GB, Silky Black)', 64999, 'USED_LIKE_NEW', 1, 'phone'],
  ['OnePlus 11 5G (8GB/128GB, Titan Black)', 56999, 'USED_GOOD', 2, 'phone'],
  ['Samsung Galaxy S23 FE 5G (8GB/128GB, Mint)', 54999, 'USED_LIKE_NEW', 0, 'phone'],
  ['Samsung Galaxy S24 5G (8GB/128GB, Onyx Black)', 74999, 'USED_GOOD', 3, 'phone'],
  ['Samsung Galaxy Z Flip5 (8GB/256GB, Mint)', 99999, 'USED_GOOD', 1, 'phone'],
  ['Google Pixel 8a (8GB/128GB, Obsidian)', 52999, 'USED_LIKE_NEW', 2, 'phone'],
  ['Nothing Phone (2a) 5G (8GB/128GB, Black)', 25999, 'USED_GOOD', 0, 'phone'],
  ['POCO X6 Pro 5G (8GB/256GB, Yellow)', 26999, 'USED_FAIR', 2, 'phone'],
  ['Redmi Note 13 Pro+ 5G (8GB/256GB, Fusion Purple)', 31999, 'USED_GOOD', 3, 'phone'],
  ['Vivo V30 5G (8GB/256GB, Andaman Blue)', 38999, 'USED_LIKE_NEW', 1, 'phone'],
  ['Apple Watch Series 9 GPS 41mm', 41900, 'USED_LIKE_NEW', 0, 'watch'],
  ['Samsung Galaxy Watch6 Classic 47mm', 36999, 'USED_GOOD', 2, 'watch'],
  ['Fire-Boltt Ninja Call Pro Plus Smartwatch', 4999, 'USED_GOOD', 3, 'watch'],
  ['Apple AirPods Pro (2nd Gen, USB-C)', 24900, 'USED_LIKE_NEW', 1, 'buds'],
  ['Apple AirPods (3rd Gen)', 19900, 'USED_GOOD', 0, 'buds'],
  ['Samsung Galaxy Buds2 Pro', 17999, 'USED_GOOD', 3, 'buds'],
  ['OnePlus Nord Buds 2 TWS Earbuds', 2999, 'USED_GOOD', 2, 'buds'],
  ['Sony WH-1000XM5 Wireless Noise Cancelling Headphones', 29990, 'USED_LIKE_NEW', 1, 'headphones'],
  ['JBL Tune 770NC Wireless Headphones', 8999, 'USED_GOOD', 0, 'headphones'],
  ['boAt Rockerz 450 Bluetooth Headphones', 2990, 'USED_FAIR', 2, 'headphones'],
  ['Apple iPhone 16 (128GB, Black)', 79900, 'OPEN_BOX', 0, 'phone'],
  ['Apple iPhone 15 Pro (256GB, Natural Titanium)', 134900, 'USED_LIKE_NEW', 3, 'phone'],
  ['Apple iPhone 16 Pro Max (256GB, Desert Titanium)', 144900, 'USED_LIKE_NEW', 2, 'phone'],
  ['Apple iPhone 15 (128GB, Blue)', 79900, 'USED_LIKE_NEW', 3, 'phone'],
  ['OnePlus 12 5G (12GB/256GB, Silky Black)', 64999, 'USED_GOOD', 0, 'phone'],
  ['OnePlus Nord CE4 5G (8GB/128GB, Celadon Marble)', 24999, 'USED_LIKE_NEW', 3, 'phone'],
  ['Samsung Galaxy S24 Ultra 5G (12GB/256GB, Titanium Gray)', 129999, 'USED_GOOD', 1, 'phone'],
  ['Samsung Galaxy S24 5G (8GB/128GB, Onyx Black)', 74999, 'USED_LIKE_NEW', 2, 'phone'],
  ['Samsung Galaxy A55 5G (8GB/128GB, Awesome Navy)', 39999, 'USED_GOOD', 0, 'phone'],
  ['Samsung Galaxy A35 5G (8GB/128GB, Awesome Iceblue)', 30999, 'USED_FAIR', 1, 'phone'],
  ['Xiaomi 14 Civi 5G (8GB/256GB, Shadow Black)', 42999, 'USED_GOOD', 2, 'phone'],
  ['Motorola Edge 50 Fusion 5G (8GB/128GB, Forest Blue)', 22999, 'USED_LIKE_NEW', 0, 'phone'],
  ['Redmi Note 13 5G (6GB/128GB, Arctic White)', 17999, 'USED_FAIR', 3, 'phone'],
  ['Google Pixel 8a (8GB/128GB, Obsidian)', 52999, 'USED_GOOD', 1, 'phone'],
  ['Vivo V30 5G (8GB/256GB, Andaman Blue)', 38999, 'USED_GOOD', 3, 'phone'],
  ['Apple Watch Series 9 GPS 41mm', 41900, 'USED_GOOD', 2, 'watch'],
  ['Samsung Galaxy Watch6 Classic 47mm', 36999, 'USED_LIKE_NEW', 1, 'watch'],
  ['Noise ColorFit Pulse Smartwatch', 1999, 'USED_GOOD', 0, 'watch'],
  ['Apple AirPods Pro (2nd Gen, USB-C)', 24900, 'USED_GOOD', 3, 'buds'],
  ['boAt Airdopes 141 TWS Earbuds', 1999, 'USED_GOOD', 1, 'buds'],
  ['realme Buds T300 TWS Earbuds', 2999, 'USED_LIKE_NEW', 2, 'buds'],
  ['Redmi Buds 5 TWS Earbuds', 3999, 'OPEN_BOX', 0, 'buds'],
  ['Samsung Galaxy Buds2 Pro', 17999, 'USED_LIKE_NEW', 2, 'buds'],
  ['Sony WH-1000XM5 Wireless Noise Cancelling Headphones', 29990, 'USED_GOOD', 3, 'headphones'],
  ['JBL Tune 770NC Wireless Headphones', 8999, 'USED_LIKE_NEW', 2, 'headphones'],
  ['JBL Flip 6 Portable Bluetooth Speaker', 9999, 'USED_GOOD', 1, 'headphones'],
]

const CHECKLIST = {
  phone: (g, i) => ({
    Screen: g === 'USED_FAIR' ? 'Light scratches, no cracks' : g === 'USED_GOOD' ? 'No scratches visible' : 'Flawless',
    'Body / skin': SKIN[g][i % 3],
    Camera: 'All lenses clean, working',
    'Buttons & ports': 'Working',
    'Speaker & mic': 'Clear',
    Battery: 'Original battery',
  }),
  watch: (g, i) => ({ Screen: g === 'USED_GOOD' ? 'Minor hairline marks' : 'No scratches', 'Body / skin': SKIN[g][i % 3], Strap: 'Original strap included', Sensors: 'Working', Charging: 'Working' }),
  buds: (g, i) => ({ 'Left earbud': 'Working', 'Right earbud': 'Working', 'Charging case': SKIN[g][i % 3], 'Ear tips': 'New tips included', Charging: 'Working' }),
  headphones: (g, i) => ({ Earcups: g === 'USED_FAIR' ? 'Worn cushions, cleaned' : 'Clean', Headband: SKIN[g][i % 3], 'Left / right drivers': 'Balanced and clear', 'Controls & ANC': 'Working', Charging: 'Working' }),
}

const QC_CHECKS = {
  phone: (g) => [
    ['Display & touch', 'PASS', 'No dead pixels, touch responsive'],
    ['Speakers & mic', 'PASS', 'Loud and clear'],
    ['Wi-Fi, Bluetooth & mobile network', 'PASS', 'All connected'],
    ['Biometric unlock', 'PASS', 'Working'],
    ['Charging port', 'PASS', 'Charges at rated speed'],
    ['Cameras', 'PASS', 'Focus and flash working'],
    ['USED_LIKE_NEW', 'REFURBISHED', 'OPEN_BOX'].includes(g) ? ['Body / skin', 'PASS', 'No visible marks'] : ['Body / skin', 'WARN', g === 'USED_FAIR' ? 'Visible wear marks' : 'Light hairline marks'],
    ['IMEI & blacklist', 'PASS', 'Clean, not blacklisted'],
  ],
  watch: (g) => [
    ['Display & touch', 'PASS', 'Responsive'],
    ['Heart-rate & sensors', 'PASS', 'Working'],
    ['Charging', 'PASS', 'Charges normally'],
    ['Bluetooth pairing', 'PASS', 'Pairs and syncs'],
    ['USED_LIKE_NEW', 'OPEN_BOX'].includes(g) ? ['Body / skin', 'PASS', 'No visible marks'] : ['Body / skin', 'WARN', 'Light marks on case'],
  ],
  buds: (g) => [
    ['Left & right audio', 'PASS', 'Balanced'],
    ['Microphone', 'PASS', 'Clear calls'],
    ['Charging case & battery', 'PASS', 'Holds charge'],
    ['Bluetooth pairing', 'PASS', 'Pairs instantly'],
    ['USED_LIKE_NEW', 'OPEN_BOX'].includes(g) ? ['Body / skin', 'PASS', 'No visible marks'] : ['Body / skin', 'WARN', 'Light marks on case'],
  ],
  headphones: (g) => [
    ['Audio drivers', 'PASS', 'No distortion'],
    ['Noise cancelling / controls', 'PASS', 'Working'],
    ['Microphone', 'PASS', 'Clear calls'],
    ['Battery & charging', 'PASS', 'Holds charge'],
    ['USED_LIKE_NEW', 'OPEN_BOX'].includes(g) ? ['Body / skin', 'PASS', 'No visible marks'] : ['Body / skin', 'WARN', g === 'USED_FAIR' ? 'Worn cushions' : 'Light marks on band'],
  ],
}

const ACCESSORIES = {
  phone: { USED_LIKE_NEW: 'Original box, charger cable, documents', USED_GOOD: 'Charger cable, documents', USED_FAIR: 'Phone and charger', REFURBISHED: 'Original box, charger cable, documents', OPEN_BOX: 'Sealed box opened, charger, documents' },
  watch: { USED_LIKE_NEW: 'Original box, charger', USED_GOOD: 'Charger', USED_FAIR: 'Watch and charger', REFURBISHED: 'Original box, charger', OPEN_BOX: 'Full box, charger' },
  buds: { USED_LIKE_NEW: 'Original box, charging case, cable', USED_GOOD: 'Charging case, cable', USED_FAIR: 'Charging case', REFURBISHED: 'Original box, charging case', OPEN_BOX: 'Full box, charging case, cable' },
  headphones: { USED_LIKE_NEW: 'Original box, carry case, cable', USED_GOOD: 'Cable and carry pouch', USED_FAIR: 'Headphones and cable', REFURBISHED: 'Original box, cable', OPEN_BOX: 'Full box, cable, carry case' },
}

const luhn = (base) => {
  let sum = 0
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i])
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return base + String((10 - (sum % 10)) % 10)
}
const imeiFor = (n) => luhn(`35${String(4800000000 + n * 7919).padStart(12, '0')}`.slice(0, 14))
const pick = (arr, i) => arr[i % arr.length]
const rnd = (a, b, i) => a + ((i * 7) % (b - a + 1))
const roundTo = (n, step) => Math.round(n / step) * step

async function clear() {
  const { rows: vs } = await query(`SELECT id FROM vendors WHERE slug LIKE 'used-demo-%'`)
  const ids = vs.map((v) => v.id)
  const { rows: ps } = await query(`SELECT id FROM products WHERE sku LIKE 'UD-%'`)
  for (const p of ps) {
    await query(`DELETE FROM shop_products WHERE product_id = $1`, [p.id])
    await query(`DELETE FROM products WHERE id = $1`, [p.id])
  }
  if (ids.length) {
    await query(`DELETE FROM vendor_users WHERE vendor_id = ANY($1)`, [ids])
    await query(`DELETE FROM shops WHERE vendor_id = ANY($1)`, [ids])
    await query(`DELETE FROM vendors WHERE id = ANY($1)`, [ids])
  }
  await query(`DELETE FROM users WHERE phone = ANY($1) AND name LIKE '% (owner)'`, [VENDORS.map((v) => v.phone)])
  console.log(`cleared ${ps.length} listings, ${ids.length} vendors`)
}

const STATE_CODE = { Maharashtra: '27', Karnataka: '29', 'Tamil Nadu': '33', Delhi: '07' }
const REPAIR_BRANDS = ['Apple', 'Samsung', 'OnePlus', 'Xiaomi', 'Redmi', 'POCO', 'Vivo', 'Google']
const REPAIRS = [
  ['SCREEN', 'Display replacement', 3800, 700, 1, 2], ['BATTERY', 'Battery replacement', 1400, 400, 0, 1],
  ['CHARGING', 'Charging port repair', 500, 350, 0, 1], ['CAMERA', 'Camera module replacement', 1800, 450, 1, 2],
  ['AUDIO', 'Speaker / mic repair', 450, 300, 0, 1], ['SOFTWARE', 'Software & data recovery', 0, 600, 0, 1],
]

/** Legal profile (needed for bills; demo placeholder GSTIN) + a repair price list so the vendor quotes in the repair marketplace. */
async function ensureProfileAndRepairs(vendorId, v, i) {
  const sc = STATE_CODE[v.state] || '27'
  await query(
    `INSERT INTO vendor_profiles (vendor_id, legal_name, gstin, pan_number, address_line1, city, state, pincode, latitude, longitude)
     VALUES ($1,$2,$3,'AAAAA0000A',$4,$5,$6,$7,$8,$9)
     ON CONFLICT (vendor_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, gstin = COALESCE(vendor_profiles.gstin, EXCLUDED.gstin),
       address_line1 = EXCLUDED.address_line1, city = EXCLUDED.city, state = EXCLUDED.state, pincode = EXCLUDED.pincode,
       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = NOW()`,
    [vendorId, `${v.name} Pvt Ltd`, `${sc}AAAAA0000A1Z5`, `${12 + i * 7}, Main Market`, v.city, v.state, v.pin, v.lat, v.lng])
  const mult = [1, 0.92, 0.85, 1.05][i % 4]
  for (const brand of REPAIR_BRANDS) {
    const bm = brand === 'Apple' ? 1.7 : brand === 'Samsung' ? 1.25 : brand === 'Google' ? 1.4 : 1
    for (const [problem, title, parts, labour, dmin, dmax] of REPAIRS) {
      await query(
        `INSERT INTO repair_vendor_services (vendor_id, device_category, brand, model, problem_category, title, parts_price, labour_price, est_days_min, est_days_max, warranty_days, pickup_delivery)
         VALUES ($1,'Smartphone',$2,NULL,$3,$4,$5,$6,$7,$8,90,TRUE)
         ON CONFLICT DO NOTHING`,
        [vendorId, brand, problem, title, Math.round(parts * bm * mult / 10) * 10, Math.round(labour * mult / 10) * 10 || 100, dmin, dmax])
    }
  }
}

async function ensureVendor(v, i) {
  const slug = `used-demo-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const { rows: ex } = await query('SELECT id FROM vendors WHERE slug = $1', [slug])
  if (ex[0]) { if (!DRY) await ensureProfileAndRepairs(ex[0].id, v, i); return ex[0].id }
  if (DRY) return `(new vendor ${v.name})`
  const { rows: u0 } = await query('SELECT id, name FROM users WHERE phone = $1', [v.phone])
  if (u0[0] && !u0[0].name.endsWith('(owner)')) throw new Error(`Phone ${v.phone} belongs to a real user — aborting`)
  const userId = u0[0]?.id || (await query(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, [v.phone, `${v.name} (owner)`])).rows[0].id
  const vendorId = (await query(
    `INSERT INTO vendors (name, slug, email, phone, status, is_active) VALUES ($1,$2,$3,$4,'ACTIVE',TRUE) RETURNING id`,
    [v.name, slug, `${slug}@demo.dealker.local`, v.phone])).rows[0].id
  await query(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER') ON CONFLICT DO NOTHING`, [vendorId, userId])
  await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, seller_rating, rating_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [`${v.name} — ${v.city}`, `${slug}-shop`, `UD-V${i + 1}`, `${12 + i * 7}, Main Market`, v.city, v.state, v.pin, v.lat, v.lng, vendorId, v.rating, v.reviews])
  await ensureProfileAndRepairs(vendorId, v, i)
  return vendorId
}

async function main() {
  if (CLEAR) { await clear(); return }
  const { rows: adm } = await query(`SELECT id FROM users WHERE role = 'ADMIN' AND is_active = TRUE ORDER BY created_at LIMIT 1`)
  const actorId = adm[0]?.id
  const vendorIds = []
  for (let i = 0; i < VENDORS.length; i++) vendorIds.push(await ensureVendor(VENDORS[i], i))
  console.log(`${VENDORS.length} vendors ready`)

  const qc = new QcService()
  let made = 0
  for (let n = 0; n < PLAN.length; n++) {
    const [name, newPrice, g, vi, kind] = PLAN[n]
    const sku = `UD-${String(n + 1).padStart(3, '0')}`
    const { rows: dup } = await query(`SELECT 1 FROM products WHERE sku = $1`, [sku])
    if (dup[0]) continue
    const { rows: src } = await query(
      `SELECT category_id, thumbnail_url, images, brand FROM products WHERE name = $1 AND owner_type = 'ADMIN' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [name])
    if (!src[0]) { console.log(`  skip ${name}: no catalog photos`); continue }
    const imgs = (Array.isArray(src[0].images) ? src[0].images : []).filter(Boolean)
    const images = [...new Set([src[0].thumbnail_url, ...imgs].filter(Boolean))]
    while (images.length < 3) images.push(images[0])
    const spec = GRADE[g]
    const price = roundTo(newPrice * spec.pct, newPrice > 20000 ? 500 : 50)
    const battery = kind === 'phone' || kind === 'watch' || kind === 'buds' ? (g === 'OPEN_BOX' ? 100 : g === 'USED_LIKE_NEW' ? rnd(92, 98, n) : g === 'USED_GOOD' ? rnd(84, 91, n) : g === 'REFURBISHED' ? 100 : rnd(78, 83, n)) : null
    const score = rnd(spec.score[0], spec.score[1], n)
    const skin = SKIN[g][n % 3]
    const input = {
      name, categoryId: src[0].category_id, brand: src[0].brand, ownerVendorId: vendorIds[vi],
      condition: g, stock: 1, price, mrp: newPrice, images: images.slice(0, 6), sku,
      description: `${name} — ${g === 'REFURBISHED' ? 'refurbished' : 'pre-owned'} unit, tested and quality-checked by Dealker. ${skin}.`,
      conditionNotes: `${skin}. Fully working, tested by our team before listing.`,
      usageDuration: pick(spec.usage, n), warrantyInfo: spec.warranty,
      accessoriesIncluded: ACCESSORIES[kind][g], batteryHealth: battery,
      hasInvoice: g !== 'USED_FAIR', returnPolicyDays: 7, gstRate: 18, sellB2c: true, sellB2b: false,
      specifications: { Type: kind, Brand: src[0].brand || '', Model: name },
      ...(kind === 'phone' ? { imei: imeiFor(n + 1) } : { serialNumber: `SN${String(840000 + n * 37)}` }),
      vendorQc: { checklist: CHECKLIST[kind](g, n) },
    }
    console.log(`  ${sku} ${name} · ${g} · ₹${price} · ${VENDORS[vi].name} · QC ${score}`)
    if (DRY) continue
    const created = await listingsService.create(input, { vendorId: null, actorId })
    const listingId = created.id
    await qc.setManual(
      listingId, 'QC_PASSED',
      `${skin}. Inspected by Dealker QC — all functional tests passed.`, actorId,
      { score, checks: QC_CHECKS[kind](g).map(([label, status, detail]) => ({ label, status, detail })) })
    await query(
      `UPDATE products SET highlights = $2::jsonb WHERE id = $1`,
      [created.product_id || created.productId, JSON.stringify({
        0: 'Dealker QC verified — every function tested',
        1: battery ? `Battery health ${battery}%` : 'Sound and controls tested',
        2: spec.warranty,
        3: '7-day replacement if it is not as described',
      })])
    made++
  }
  console.log(`done: ${made} listings created`)
}

try { await main() } finally { await pool.end() }
