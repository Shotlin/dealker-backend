/**
 * Demo data for the Sell Requests and Exchange Requests sections.
 *
 *   npm run seed:sell-demo            add demo data (skips if it is already there)
 *   npm run seed:sell-demo -- --reset remove ONLY the demo data, then add it fresh
 *   npm run seed:sell-demo -- --clear remove ONLY the demo data
 *
 * Everything goes through the real service (valuation, offers, assignment, approvals, order links),
 * so quotes, timelines and statuses are exactly what production would produce; timestamps are then
 * spread over the last ~2 weeks. Demo rows are tagged and removable:
 *   sell_requests.is_demo = TRUE · vendors slug 'demo-%' · orders 'DEMO-O-%' · the fixed demo phone list (never a real user)
 * No notifications are sent while seeding.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

process.env.SELL_DEMO_SEED = '1'

const { query, pool } = await import('../../config/database.js')
const svc = await import('../../modules/sell-requests/sell-requests.service.js')
const { UPLOAD_DIR, PUBLIC_BASE } = await import('../../modules/uploads/local-uploads.routes.js')

const args = new Set(process.argv.slice(2))

// ── deterministic randomness so every environment gets the same story ─────
let seedState = 20260301
const rand = () => ((seedState = (seedState * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = (a) => a[Math.floor(rand() * a.length)]
const chance = (p) => rand() < p

// ── people & places ──────────────────────────────────────────────────────
const CUSTOMERS = [
  ['Rohit Kumar', 'Kolkata'], ['Priya Singh', 'Howrah'], ['Amit Yadav', 'Salt Lake'], ['Neha Sharma', 'Kolkata'],
  ['Vikram Singh', 'Durgapur'], ['Sneha Kapoor', 'Siliguri'], ['Manish Gupta', 'Kolkata'], ['Anjali Mehta', 'Howrah'],
  ['Karan Malhotra', 'Salt Lake'], ['Rohit Das', 'Kolkata'], ['Pooja Nair', 'Siliguri'], ['Hardik Joshi', 'Durgapur'],
  ['Divya Iyer', 'Kolkata'], ['Sagar Bansal', 'Howrah'], ['Meera Banerjee', 'Kolkata'], ['Arjun Chatterjee', 'Salt Lake'],
]
const VENDORS = [
  ['TechFix Hub', 'Kolkata', 4.8, 22.5726, 88.3639], ['Mobile Mart', 'Kolkata', 4.6, 22.5448, 88.3426],
  ['Gadget Galaxy', 'Howrah', 4.4, 22.5958, 88.2636], ['ReNew Devices', 'Salt Lake', 4.7, 22.5867, 88.4171],
  ['CityMobiles', 'Siliguri', 4.3, 26.7271, 88.3953],
]
// Exact demo phone numbers — reset deletes only these, and refuses to adopt a real user with the same number.
const ADMIN_PHONE = '9800000001'
const CUSTOMER_PHONES = CUSTOMERS.map((_, i) => `98000${10 + i}${String(100 + i * 7).padStart(3, '0')}`)
const VENDOR_USER_PHONES = VENDORS.map((_, i) => `98000${20 + i}${String(300 + i)}0`.slice(0, 10))
const VENDOR_PHONES = VENDORS.map((_, i) => `98000${30 + i}${String(400 + i)}0`.slice(0, 10))
const DEMO_USER_PHONES = [ADMIN_PHONE, ...CUSTOMER_PHONES, ...VENDOR_USER_PHONES]
const NEW_PHONES = [
  ['iPhone 15 (128GB)', 69900], ['Samsung Galaxy S24 (256GB)', 74999], ['OnePlus 12 (256GB)', 64999], ['Pixel 8 (128GB)', 59999],
  ['Redmi Note 13 Pro+ (256GB)', 29999], ['Realme 12 Pro+ (256GB)', 29999], ['iPad 10th Gen (64GB)', 34900], ['MacBook Air M2 (256GB)', 99900],
]
const REJECT_REASONS = ['IMEI is blacklisted / reported lost', 'Device photos do not match the described condition', 'Model no longer accepted', 'Screen replaced with a non-genuine panel']
const INFO_ASKS = ['Please upload a clear photo of the back panel.', 'Please share a screenshot of Battery Health (Settings → Battery).', 'Photo of the IMEI sticker on the box, please.']
const DESCRIPTIONS = [
  'Used carefully with a case and screen guard since day one.', 'Selling because I am upgrading. Works perfectly.', 'Small scratch near the camera, otherwise perfect.',
  'Original box and charger included.', 'Battery has been replaced at an authorised service centre.', 'Bought last year, light usage, no repairs.',
]

// ── Luhn-valid unique IMEIs ──────────────────────────────────────────────
let imeiCounter = 0
function imei() {
  const body = String(35693803000000 + 7919 * (++imeiCounter) + Math.floor(rand() * 7)).slice(0, 14)
  for (let c = 0; c < 10; c++) {
    const s = body + c
    let sum = 0
    for (let i = 0; i < 15; i++) { let n = Number(s[14 - i]); if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n }
    if (sum % 10 === 0) return s
  }
}

// ── photos: generated SVGs saved next to normal uploads ──────────────────
function writePhotos() {
  const dir = path.join(UPLOAD_DIR, 'demo')
  fs.mkdirSync(dir, { recursive: true })
  const views = [
    ['front', '#4f46e5', '#ec4899', 'Front'], ['back', '#0ea5e9', '#6366f1', 'Back'], ['side', '#10b981', '#0ea5e9', 'Side'],
    ['screen-on', '#f59e0b', '#ef4444', 'Screen on'], ['box', '#64748b', '#0f172a', 'Box & bill'], ['charger', '#14b8a6', '#22c55e', 'Charger'],
  ]
  return views.map(([name, a, b, label]) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="480" height="640" fill="#e2e8f0"/>
  <rect x="120" y="60" width="240" height="520" rx="36" fill="#0f172a"/>
  <rect x="132" y="76" width="216" height="488" rx="26" fill="url(#g)"/>
  <rect x="200" y="86" width="80" height="16" rx="8" fill="#0f172a"/>
  <text x="240" y="330" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>
  <text x="240" y="362" font-family="Arial,Helvetica,sans-serif" font-size="14" fill="#fff" fill-opacity=".8" text-anchor="middle">demo photo</text>
</svg>`
    fs.writeFileSync(path.join(dir, `${name}.svg`), svg)
    return `${PUBLIC_BASE}/demo/${name}.svg`
  })
}

const DEMO_USER_NAMES = ['Demo Admin', ...CUSTOMERS.map(([n]) => n), ...VENDORS.map(([n]) => `${n} (owner)`)]

// ── cleanup ──────────────────────────────────────────────────────────────
async function clear() {
  await query(`DELETE FROM sell_requests WHERE is_demo`)
  await query(`DELETE FROM orders WHERE order_number LIKE 'DEMO-O-%'`)
  await query(`DELETE FROM vendor_users WHERE vendor_id IN (SELECT id FROM vendors WHERE slug LIKE 'demo-%')`)
  await query(`DELETE FROM shops WHERE vendor_id IN (SELECT id FROM vendors WHERE slug LIKE 'demo-%')`)
  await query(`DELETE FROM vendors WHERE slug LIKE 'demo-%'`)
  await query(`DELETE FROM users WHERE phone = ANY($1) AND name = ANY($2)`, [DEMO_USER_PHONES, DEMO_USER_NAMES])
}

// ── fixtures ─────────────────────────────────────────────────────────────
async function ensureUser(phone, name, role = 'CUSTOMER') {
  const { rows: ex } = await query('SELECT id, name FROM users WHERE phone = $1', [phone])
  if (ex[0]) {
    if (ex[0].name !== name) throw new Error(`Demo phone ${phone} already belongs to a real user (${ex[0].name}). Aborting so nothing real is touched.`)
    return ex[0].id
  }
  const { rows } = await query(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id`, [phone, name, role])
  return rows[0].id
}

async function setupPeople() {
  const { rows: adm } = await query(`SELECT id FROM users WHERE role = 'ADMIN' AND is_active = TRUE ORDER BY created_at LIMIT 1`)
  const adminId = adm[0]?.id || await ensureUser(ADMIN_PHONE, 'Demo Admin', 'ADMIN')

  const customers = []
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const [name, city] = CUSTOMERS[i]
    const phone = CUSTOMER_PHONES[i]
    customers.push({ id: await ensureUser(phone, name), name, city, phone })
  }

  const vendors = []
  for (let i = 0; i < VENDORS.length; i++) {
    const [name, city, rating, lat, lng] = VENDORS[i]
    const slug = `demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const userId = await ensureUser(VENDOR_USER_PHONES[i], `${name} (owner)`)
    const { rows: ex } = await query('SELECT id FROM vendors WHERE slug = $1', [slug])
    let vendorId = ex[0]?.id
    if (!vendorId) {
      const v = await query(
        `INSERT INTO vendors (name, slug, email, phone, status, is_active) VALUES ($1,$2,$3,$4,'ACTIVE',TRUE) RETURNING id`,
        [name, slug, `${slug}@demo.dealker.local`, VENDOR_PHONES[i]])
      vendorId = v.rows[0].id
      await query(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER') ON CONFLICT DO NOTHING`, [vendorId, userId])
      await query(
        `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, seller_rating, rating_count)
         VALUES ($1,$2,$3,'Demo Market Road',$4,'West Bengal','700001',$5,$6,$7,$8,$9)`,
        [`${name} — ${city}`, `${slug}-shop`, `DEMO-V${i + 1}`, city, lat, lng, vendorId, rating, 40 + i * 13])
    }
    vendors.push({ id: vendorId, userId, name, city })
  }
  return { adminId, customers, vendors }
}

// ── scenarios ────────────────────────────────────────────────────────────
const PROFILES = {
  EXCELLENT: () => ({ ageMonths: 3 + Math.floor(rand() * 5), screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 92 + Math.floor(rand() * 8), powersOn: true }),
  GOOD: () => ({ ageMonths: 10 + Math.floor(rand() * 10), screenScratches: chance(0.6) ? 'MINOR' : 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: chance(0.3), billAvailable: chance(0.7), boxAvailable: chance(0.7), chargerAvailable: true, batteryHealth: 84 + Math.floor(rand() * 8), powersOn: true }),
  FAIR: () => ({ ageMonths: 20 + Math.floor(rand() * 10), screenScratches: 'MINOR', bodyDents: chance(0.5), screenReplaced: chance(0.3), skinReplaced: chance(0.4), billAvailable: chance(0.4), boxAvailable: chance(0.3), chargerAvailable: chance(0.6), batteryHealth: 74 + Math.floor(rand() * 8), powersOn: true }),
  POOR: () => ({ ageMonths: 34 + Math.floor(rand() * 14), screenScratches: 'MAJOR', bodyDents: true, screenReplaced: chance(0.5), skinReplaced: true, billAvailable: false, boxAvailable: false, chargerAvailable: chance(0.3), batteryHealth: 58 + Math.floor(rand() * 14), powersOn: chance(0.7) }),
}

// target statuses, in the order scenarios are dealt out
const SELL_PLAN = [
  ...Array(12).fill('PENDING'), ...Array(8).fill('IN_PROGRESS'), ...Array(8).fill('APPROVED'),
  ...Array(10).fill('COMPLETED'), ...Array(5).fill('REJECTED'), ...Array(5).fill('CANCELLED'),
]
const EXCHANGE_PLAN = [
  ...Array(8).fill('PENDING'), ...Array(5).fill('IN_PROGRESS'), ...Array(7).fill('APPROVED'),
  ...Array(8).fill('COMPLETED'), ...Array(3).fill('REJECTED'), ...Array(3).fill('CANCELLED'),
]
// event offsets after submission, in minutes, assigned to the request's events in order
const EVENT_OFFSETS = [0, 38, 95, 170, 240, 1500]

const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [r[i], r[j]] = [r[j], r[i]] } return r }

async function scenario({ kind, target, idx, ctx, photos }) {
  const { adminId, customers, vendors } = ctx
  const models = await svc.listModels()
  // An exchange is an upgrade: the new phone costs clearly more than the old one is worth.
  const newPhone = kind === 'EXCHANGE' ? pick(NEW_PHONES) : null
  const pool_ = kind === 'EXCHANGE'
    ? models.filter((m) => m.category !== 'Laptop' && m.basePrice <= newPhone[1] * 0.7)
    : models
  const model = pick(pool_.length ? pool_ : models.filter((m) => m.category === 'Smartphone').sort((a, b) => a.basePrice - b.basePrice).slice(0, 3))
  const variant = pick(model.variants), color = pick(model.colors)
  const condition = pick(['EXCELLENT', 'EXCELLENT', 'EXCELLENT', 'GOOD', 'GOOD', 'GOOD', 'GOOD', 'FAIR', 'FAIR', 'POOR'])
  const qa = PROFILES[condition]()
  const cust = customers[idx % customers.length]
  const walkIn = chance(0.12)
  const type = kind === 'EXCHANGE' ? 'EXCHANGE' : (chance(0.7) ? 'SELL_TO_AB' : 'BUY_NOW')
  const actor = walkIn
    ? { kind: 'ADMIN', scopeKind: kind, userId: adminId, vendorId: null }
    : { kind: 'CUSTOMER', scopeKind: kind, userId: cust.id }
  const admin = { kind: 'ADMIN', scopeKind: kind, userId: adminId, vendorId: null }
  const vendorActor = (v) => ({ kind: 'VENDOR', scopeKind: kind, userId: v.userId, vendorId: v.id })

  const input = {
    type, model: model.name, variant, color, imei: imei(), qa,
    description: pick(DESCRIPTIONS),
    images: shuffle(photos).slice(0, 2 + Math.floor(rand() * 3)),
    customer: walkIn ? { name: cust.name, phone: cust.phone, city: cust.city } : { city: cust.city },
  }
  let order = null
  if (kind === 'EXCHANGE') {
    const [name, price] = newPhone
    input.exchange = { newProduct: name, newProductPrice: price }
    // ~60% already bought the new phone: the order exists before the exchange is raised
    if (!walkIn && target !== 'REJECTED' && chance(0.6)) {
      const num = `DEMO-O-${String(1000 + idx)}`
      const delivered = target === 'COMPLETED'
      const { rows } = await query(
        `INSERT INTO orders (order_number, customer_id, items, subtotal, total_payable, delivery_address, status)
         VALUES ($1,$2,$3,$4,$4,$5,$6) ON CONFLICT (order_number) DO UPDATE SET status = EXCLUDED.status RETURNING id`,
        [num, cust.id, JSON.stringify([{ name, quantity: 1, price }]), price,
          JSON.stringify({ name: cust.name, line1: 'Demo Lane', city: cust.city, pincode: '700001' }), delivered ? 'DELIVERED' : 'ORDER_PLACED'])
      order = { id: rows[0].id, num }
      input.orderNumber = num
    }
  }

  let r = await svc.createRequest(actor, input)
  const id = r.id
  await query('UPDATE sell_requests SET is_demo = TRUE WHERE id = $1', [id])

  const offerable = ['IN_PROGRESS', 'APPROVED', 'COMPLETED'].includes(target) || (target === 'PENDING' && chance(0.6)) || (target === 'REJECTED' && chance(0.5))
  const bidders = []
  if (offerable) {
    const n = 1 + Math.floor(rand() * 3) + (target === 'PENDING' ? 0 : 1)
    for (const v of shuffle(vendors).slice(0, Math.min(n, vendors.length))) {
      const amount = Math.round((r.quote * (0.93 + rand() * 0.12)) / 100) * 100
      await svc.placeOffer(vendorActor(v), id, { amount, distanceKm: Math.round((2 + rand() * 16) * 10) / 10, note: chance(0.3) ? 'Can collect today' : undefined })
      bidders.push({ v, amount })
    }
  }

  if (target === 'PENDING' && chance(0.25)) await svc.requestInfo(admin, id, pick(INFO_ASKS))

  if (['IN_PROGRESS', 'APPROVED', 'COMPLETED'].includes(target)) {
    const best = bidders.sort((a, b) => b.amount - a.amount)[0]
    await svc.assignVendor(admin, id, best.v.id)
  }
  if (['APPROVED', 'COMPLETED'].includes(target)) await svc.approve(admin, id)
  if (target === 'COMPLETED') {
    if (kind === 'EXCHANGE' && !order) {
      const num = `DEMO-O-${String(2000 + idx)}`
      const { rows } = await query(
        `INSERT INTO orders (order_number, customer_id, items, subtotal, total_payable, delivery_address, status)
         VALUES ($1,$2,$3,$4,$4,$5,'DELIVERED') RETURNING id`,
        [num, cust.id, JSON.stringify([{ name: input.exchange.newProduct, quantity: 1, price: input.exchange.newProductPrice }]), input.exchange.newProductPrice,
          JSON.stringify({ name: cust.name, line1: 'Demo Lane', city: cust.city, pincode: '700001' })])
      await svc.linkOrder(admin, id, num)
      order = { id: rows[0].id, num }
    }
    await svc.complete(admin, id)
  }
  // some approved exchanges are still waiting for the customer to buy the new phone ("awaiting order")
  if (target === 'REJECTED') await svc.reject(admin, id, pick(REJECT_REASONS))
  if (target === 'CANCELLED') {
    await svc.cancel(walkIn ? admin : { kind: 'CUSTOMER', scopeKind: kind, userId: cust.id }, id, chance(0.5) ? 'Customer changed their mind' : undefined)
  }

  // ── spread timestamps (events follow their natural rhythm; nothing lands in the future) ──
  const ageMin = 400 + (target === 'COMPLETED' ? 1300 : 0) + Math.floor(rand() * (14 * 24 * 60 - 1700))
  const created = new Date(Date.now() - ageMin * 60_000)
  await query(`UPDATE sell_requests SET created_at = $2::timestamptz, updated_at = $2::timestamptz + INTERVAL '30 minutes' WHERE id = $1`, [id, created])
  const { rows: ev } = await query(`SELECT id, kind, meta FROM sell_request_events WHERE request_id = $1 ORDER BY id`, [id])
  let t = 0
  for (const e of ev) {
    if (e.kind === 'ORDER_LINKED') t += 15
    else if (e.kind === 'QUOTE_RECEIVED') t += 20 + Math.floor(rand() * 25)
    else if (e.kind === 'INFO_REQUESTED') t += 30
    else if (e.kind === 'VENDOR_ASSIGNED') t = Math.max(t + 40, 200)
    else if (e.kind === 'APPROVED') t += 45 + Math.floor(rand() * 30)
    else if (e.kind === 'COMPLETED') t += 1200
    else if (e.kind === 'REJECTED') t += 120
    else if (e.kind === 'CANCELLED') t += 45
    const at = new Date(created.getTime() + t * 60_000)
    await query('UPDATE sell_request_events SET created_at = $2 WHERE id = $1', [e.id, at])
    if (e.kind === 'QUOTE_RECEIVED' && e.meta?.vendorId) {
      await query(`UPDATE sell_request_offers SET created_at = $3, updated_at = $3 WHERE request_id = $1 AND vendor_id = $2`, [id, e.meta.vendorId, at])
    }
    if (['APPROVED', 'REJECTED'].includes(e.kind)) await query('UPDATE sell_requests SET decided_at = $2 WHERE id = $1', [id, at])
  }
  return { code: r.code, kind, target }
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  if (args.has('--clear') || args.has('--reset')) {
    await clear()
    console.log('🧹 Removed demo sell/exchange data')
    if (args.has('--clear')) return
  }
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM sell_requests WHERE is_demo')
  if (rows[0].n > 0) {
    console.log(`ℹ️  Demo data already present (${rows[0].n} requests). Use --reset to rebuild it.`)
    return
  }

  const photos = writePhotos()
  const ctx = await setupPeople()
  const made = []
  let i = 0
  for (const target of shuffle(SELL_PLAN)) made.push(await scenario({ kind: 'SELL', target, idx: i++, ctx, photos }))
  for (const target of shuffle(EXCHANGE_PLAN)) made.push(await scenario({ kind: 'EXCHANGE', target, idx: i++, ctx, photos }))

  const tally = (k) => Object.entries(made.filter((m) => m.kind === k).reduce((a, m) => ({ ...a, [m.target]: (a[m.target] || 0) + 1 }), {})).map(([s, n]) => `${s} ${n}`).join(' · ')
  console.log(`✅ Sell requests     ${made.filter((m) => m.kind === 'SELL').length}: ${tally('SELL')}`)
  console.log(`✅ Exchange requests ${made.filter((m) => m.kind === 'EXCHANGE').length}: ${tally('EXCHANGE')}`)
  console.log(`✅ ${ctx.vendors.length} vendors with shops · ${ctx.customers.length} customers · demo photos in ${path.join(UPLOAD_DIR, 'demo')}`)
}

try {
  await main()
} catch (err) {
  console.error('Demo seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
