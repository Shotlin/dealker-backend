/**
 * Demo listings for the vendor shop "Shotlin" (phone 9775845587) — 6 products across every condition:
 *   Refurbished iPhone 15 ×10 · Open-box Galaxy S24 ×4 · Used OnePlus 11 ×3 · Used iPhone 12 ×5 (each unit has its own QC)
 *   Brand-new Redmi Note 13 Pro ×25 · Brand-new realme Buds T300 ×60 (no QC needed)
 * Also gives the shop's older refurbished iPhone 16 Pro Max (which had no per-device QC) 10 units with QC.
 *
 *   node src/database/seeds/shotlin-demo-products.js          idempotent (skips products that already exist)
 */
const { query, pool } = await import('../../config/database.js')
const { listingsService } = await import('../../modules/listings/listings.service.js')
const { createUnits } = await import('../../modules/listing-units/units.service.js')
const { getClient } = await import('../../config/database.js')

const IMG = (process.env.UPLOAD_BASE_URL || 'https://api.dealker.agnixstudio.in/uploads/products').replace(/\/$/, '')
const imgs = (base, n = 5) => Array.from({ length: n }, (_, i) => `${IMG}/${base}-${i + 1}.jpg`)

const MOBILES = '99907ba9-4e61-4265-91ff-19822dfa36ac'
const AUDIO = '0b597ce6-a597-442b-81e7-3cd523c3d808'

const FUNCS = ['touch', 'wifi', 'bluetooth', 'gps', 'cameras', 'speaker', 'microphone', 'biometric', 'volume_buttons', 'power_button', 'charging_port', 'vibrator', 'proximity_sensor', 'sim_tray', 'audio_jack']
/** One device's QC: everything fine unless `o` says otherwise. */
const qc = (battery, o = {}, { iphone = false } = {}) => ({
  battery: { health: battery },
  screen: { lcd: o.lcd || 'WORKING', condition: o.screen || 'FLAWLESS' },
  physical: { body: o.body || 'LIKE_NEW', back: o.back || 'LIKE_NEW', frame: o.frame || 'STRAIGHT' },
  functional: Object.fromEntries(FUNCS.map((k) => [k, (o.fail || []).includes(k) ? 'FAIL' : (k === 'audio_jack' && iphone ? 'NA' : 'PASS')])),
  ...(o.notes ? { notes: o.notes } : {}),
})

const IP = { iphone: true }
const REFURB_IP15 = [
  qc(100, {}, IP), qc(98, {}, IP), qc(96, {}, IP), qc(100, { back: 'GOOD' }, IP), qc(95, {}, IP),
  qc(97, {}, IP), qc(94, { screen: 'MINOR_SCRATCHES', body: 'GOOD', notes: 'Faint hairline scratch on the screen edge.' }, IP), qc(99, {}, IP),
  qc(92, { fail: ['vibrator'], notes: 'Vibration motor is weak — priced in.' }, IP), qc(100, {}, IP),
]
const OPEN_S24 = [qc(100), qc(100), qc(100, { back: 'GOOD', notes: 'Tiny mark on the back glass.' }), qc(100)]
const USED_OP11 = [
  qc(88, { screen: 'MINOR_SCRATCHES', body: 'GOOD', back: 'GOOD' }),
  qc(84, { screen: 'MINOR_SCRATCHES', body: 'GOOD', back: 'FAIR', notes: 'Light scuffs on the back.' }),
  qc(79, { screen: 'VISIBLE_SCRATCHES', body: 'FAIR', frame: 'SCUFFED', notes: 'Battery has started to age; frame has visible scuffs.' }),
]
const USED_IP12 = [
  qc(91, { body: 'GOOD' }, IP), qc(89, { body: 'GOOD', back: 'GOOD' }, IP), qc(87, { screen: 'MINOR_SCRATCHES', body: 'GOOD' }, IP),
  qc(90, { body: 'GOOD' }, IP), qc(85, { screen: 'MINOR_SCRATCHES', body: 'GOOD', frame: 'SCUFFED' }, IP),
]
const QC_16PM = Array.from({ length: 10 }, (_, i) => qc([100, 99, 97, 100, 96, 98, 95, 100, 93, 99][i], i === 6 ? { back: 'GOOD' } : {}, IP))

const PRODUCTS = [
  { name: 'Apple iPhone 15 (128GB, Blue)', brand: 'Apple', cat: MOBILES, condition: 'REFURBISHED', stock: 10, price: 47990, mrp: 69900, wholesale: 44500, moq: 2, base: 'apple-iphone-15-128gb-blue-1',
    specs: { product_type: 'mobile', model: 'iPhone 15', storage: '128GB', RAM: '6 GB', Display: '6.1 inch Super Retina XDR', Chip: 'A16 Bionic', Camera: '48 MP + 12 MP', Network: '5G' },
    warranty: '6 Months seller warranty', box: 'Original box, USB-C cable, GST invoice', notes: 'Professionally refurbished, tested device by device. New battery on weaker units, original accessories.', unitQc: REFURB_IP15 },
  { name: 'Samsung Galaxy S24 5G (8GB/128GB, Onyx Black)', brand: 'Samsung', cat: MOBILES, condition: 'OPEN_BOX', stock: 4, price: 52990, mrp: 79999, wholesale: 49000, moq: 1, base: 'samsung-galaxy-s24-5g-8gb-128gb-onyx-black-74e650',
    specs: { product_type: 'mobile', model: 'Galaxy S24', storage: '128GB', RAM: '8 GB', Display: '6.2 inch Dynamic AMOLED 2X 120Hz', Chip: 'Exynos 2400', Camera: '50 MP + 12 MP + 10 MP', Network: '5G' },
    warranty: '1 Year brand warranty', box: 'Original box, USB-C cable, charger, GST invoice', notes: 'Box opened for inspection only. Never used; all seals and accessories present.', unitQc: OPEN_S24 },
  { name: 'OnePlus 11 5G (8GB/128GB, Titan Black)', brand: 'OnePlus', cat: MOBILES, condition: 'USED_GOOD', stock: 3, price: 24990, mrp: 56999, wholesale: 22500, moq: 1, base: 'oneplus-11-5g-8gb-128gb-titan-black-7b1d4a',
    specs: { product_type: 'mobile', model: 'OnePlus 11', storage: '128GB', RAM: '8 GB', Display: '6.7 inch AMOLED 120Hz', Chip: 'Snapdragon 8 Gen 2', Camera: '50 MP + 48 MP + 32 MP', Network: '5G' },
    warranty: '3 Months seller warranty', box: 'Charger, cable', notes: 'Light daily use for about a year. Marks on body and screen edge; everything works.', unitQc: USED_OP11 },
  { name: 'Apple iPhone 12 (64GB, Blue)', brand: 'Apple', cat: MOBILES, condition: 'USED_LIKE_NEW', stock: 5, price: 26990, mrp: 59900, wholesale: 24500, moq: 1, base: 'apple-iphone-12-64gb-blue-0231aa',
    specs: { product_type: 'mobile', model: 'iPhone 12', storage: '64GB', RAM: '4 GB', Display: '6.1 inch Super Retina XDR', Chip: 'A14 Bionic', Camera: '12 MP + 12 MP', Network: '5G' },
    warranty: '3 Months seller warranty', box: 'Charger, GST invoice', notes: 'Used for a few months by the first owner. Very light marks only.', unitQc: USED_IP12 },
  { name: 'Redmi Note 13 Pro 5G (8GB/256GB, Fusion Purple)', brand: 'Redmi', cat: MOBILES, condition: 'NEW', stock: 25, price: 22999, mrp: 26999, wholesale: 20400, moq: 5, base: 'redmi-note-13-pro-5g-8gb-256gb-fusion-purple-838f58',
    specs: { product_type: 'mobile', model: 'Redmi Note 13 Pro 5G', storage: '256GB', RAM: '8 GB', Display: '6.67 inch AMOLED 120Hz', Chip: 'Snapdragon 7s Gen 2', Camera: '200 MP + 8 MP + 2 MP', Battery: '5100 mAh' },
    warranty: '1 Year', box: 'Sealed box, charger, cable, GST invoice' },
  { name: 'realme Buds T300 TWS Earbuds (Youth White)', brand: 'realme', cat: AUDIO, condition: 'NEW', stock: 60, price: 2299, mrp: 3999, wholesale: 1650, moq: 20, base: 'realme-buds-t300-tws-earbuds-602099',
    specs: { product_type: 'accessories', model: 'Buds T300', Driver: '12.4 mm', ANC: 'Up to 30 dB', Battery: 'Up to 40 hours', Network: 'Bluetooth 5.3' },
    warranty: '1 Year', box: 'Sealed box, charging case, cable, GST invoice' },
]

const owner = (await query(
  `SELECT v.id AS vendor_id, u.id AS user_id FROM vendors v JOIN vendor_users vu ON vu.vendor_id = v.id JOIN users u ON u.id = vu.user_id WHERE u.phone = '9775845587' LIMIT 1`)).rows[0]
if (!owner) throw new Error('Shotlin vendor (9775845587) not found')

let made = 0
for (const p of PRODUCTS) {
  const { rows: ex } = await query(`SELECT 1 FROM products WHERE owner_vendor_id = $1 AND name = $2 AND deleted_at IS NULL`, [owner.vendor_id, p.name])
  if (ex.length) { console.log('exists:', p.name); continue }
  await listingsService.create({
    name: p.name, brand: p.brand, categoryId: p.cat, condition: p.condition, stock: p.stock, images: imgs(p.base),
    conditionNotes: p.notes || undefined, warrantyInfo: p.warranty, accessoriesIncluded: p.box, hasInvoice: true,
    price: p.price, mrp: p.mrp, sellB2c: true, sellB2b: true, wholesalePrice: p.wholesale, moq: p.moq, b2bDiscountPct: Math.round((1 - p.wholesale / p.price) * 100),
    specifications: p.specs, ownerVendorId: owner.vendor_id,
    ...(p.unitQc ? { unitQc: p.unitQc, batteryHealth: Math.min(...p.unitQc.map((u) => u.battery.health)), usageDuration: p.condition.startsWith('USED') ? '8 months' : undefined } : {}),
    highlights: Object.entries(p.specs).filter(([k]) => !['product_type', 'model', 'storage'].includes(k)).slice(0, 5).map(([k, v]) => `${k}: ${v}`),
  }, { vendorId: null, actorId: owner.user_id })
  made++
  console.log('created:', p.name)
}

// the shop's older refurbished iPhone 16 Pro Max: 10 devices, each with a QC
const old = (await query(
  `SELECT sp.id, sp.stock_quantity FROM shop_products sp JOIN products p ON p.id = sp.product_id
    WHERE p.owner_vendor_id = $1 AND p.name = 'Apple iPhone 16 Pro Max (128GB)' AND sp.deleted_at IS NULL LIMIT 1`, [owner.vendor_id])).rows[0]
if (old && !(await query(`SELECT 1 FROM listing_units WHERE shop_product_id = $1`, [old.id])).rows.length) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE shop_products SET stock_quantity = 10 WHERE id = $1`, [old.id])
    await client.query(`UPDATE products SET stock_quantity = 10 WHERE id = (SELECT product_id FROM shop_products WHERE id = $1)`, [old.id])
    await createUnits(client, old.id, QC_16PM, { actorId: owner.user_id })
    await client.query('COMMIT')
    console.log('iPhone 16 Pro Max: 10 devices with QC (stock 10)')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}
console.log(`done — ${made} new listings`)
await pool.end()
