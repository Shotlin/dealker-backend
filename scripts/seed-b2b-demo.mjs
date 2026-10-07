/**
 * Demo vendor-to-vendor B2B activity, produced by running the real service flows
 * (requirements → quotes → split awards → escrow → dispatch → receipt/dispute),
 * then back-dating the timeline. Idempotent.
 * Run: docker compose exec api node scripts/seed-b2b-demo.mjs
 */
import 'dotenv/config'
const { query } = await import('../src/config/database.js')
const { b2b } = await import('../src/modules/b2b/b2b.service.js')

if ((await query(`SELECT 1 FROM b2b_requirements LIMIT 1`)).rows[0]) { console.log('B2B demo data already present.'); process.exit(0) }

const V = Object.fromEntries((await query(`SELECT id, name, slug FROM vendors`)).rows.map((v) => [v.slug, v.id]))
const adminId = (await query(`SELECT id FROM users WHERE email='superadmin@dealker.local'`)).rows[0]?.id
const cat = Object.fromEntries((await query(`SELECT id, name FROM categories`)).rows.map((c) => [c.name, c.id]))
const days = (n) => new Date(Date.now() + n * 86400000).toISOString()
const A = (vendorId) => ({ userId: null, vendorId, label: 'Vendor' })
const ADMIN = { userId: adminId, isAdmin: true, label: 'Dealker admin' }
const quote = (rid, vendor, quantity, unitPrice, condition, deliveryDays, note) => b2b.upsertQuote(rid, V[vendor], { quantity, unitPrice, condition, deliveryDays, note, photos: [] }, A(V[vendor]))
const req = (vendor, productName, quantity, extra = {}) => b2b.createRequirement({ productName, quantity, responseDeadline: days(3), deliveryCity: 'Bengaluru', deliveryPincode: '560034', ...extra }, vendor ? A(V[vendor]) : ADMIN)
const order = async (rid, vendor) => (await query(`SELECT * FROM b2b_orders WHERE requirement_id=$1 AND seller_vendor_id=$2`, [rid, V[vendor]])).rows[0]
const seller = (o, status, extra = {}) => b2b.sellerUpdate(o.id, o.seller_vendor_id, { status, ...extra }, A(o.seller_vendor_id))
const shift = async (rid, d) => {
  const q = (t, col = 'created_at') => query(`UPDATE ${t} SET ${col} = ${col} - ($2 || ' days')::interval WHERE ${t === 'b2b_requirements' ? 'id' : 'requirement_id'} = $1`, [rid, String(d)])
  await q('b2b_requirements'); await q('b2b_quotes'); await q('b2b_orders'); await q('b2b_events'); await q('b2b_payments')
  await query(`UPDATE b2b_requirements SET updated_at = updated_at - ($2 || ' days')::interval WHERE id=$1`, [rid, String(d)])
  await query(`UPDATE b2b_orders SET paid_at=paid_at-($2||' days')::interval, packed_at=packed_at-($2||' days')::interval, dispatched_at=dispatched_at-($2||' days')::interval, delivered_at=delivered_at-($2||' days')::interval, received_at=received_at-($2||' days')::interval, released_at=released_at-($2||' days')::interval WHERE requirement_id=$1`, [rid, String(d)])
  await query(`UPDATE settlement_ledger SET created_at = created_at - ($2||' days')::interval WHERE idempotency_key LIKE 'b2b:%' AND idempotency_key IN (SELECT 'b2b:'||id||':GROSS' FROM b2b_orders WHERE requirement_id=$1 UNION SELECT 'b2b:'||id||':COMM' FROM b2b_orders WHERE requirement_id=$1)`, [rid, String(d)])
}

await b2b.setVendorCommission(V['gadget-galaxy'], 8) // per-seller override example

// 1) 15 × iPhone 16 — split across three sellers, mixed progress
let r = await req('gadget-galaxy', 'Apple iPhone 16 (128GB)', 15, { brand: 'Apple', categoryId: cat['Electronics'], conditionPref: 'NEW', targetPrice: 72000, description: 'Sealed boxes with GST invoice. Need before month end.' })
await quote(r.id, 'technest-retail', 5, 71500, 'NEW', 2, 'Sealed, GST invoice, ready to ship')
await quote(r.id, 'glow-co-beauty', 2, 72000, 'NEW', 3)
await quote(r.id, 'fitstreet-sports', 15, 70200, 'NEW', 5, 'Can supply the full lot, 5 days')
await b2b.award(r.id, [{ quoteId: (await query(`SELECT id FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [r.id, V['technest-retail']])).rows[0].id, quantity: 5 },
  { quoteId: (await query(`SELECT id FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [r.id, V['glow-co-beauty']])).rows[0].id, quantity: 2 },
  { quoteId: (await query(`SELECT id FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [r.id, V['fitstreet-sports']])).rows[0].id, quantity: 8 }], A(V['gadget-galaxy']))
await b2b.pay(r.id, { method: 'ONLINE', reference: 'RZP-B2B-7781' }, A(V['gadget-galaxy']))
let o = await order(r.id, 'technest-retail'); await seller(o, 'DISPATCHED', { courierName: 'Blue Dart', awb: 'BD88217733', trackingUrl: 'https://track.dealker.in/BD88217733' }); await b2b.receive(o.id, { receivedQuantity: 5, ok: true }, A(V['gadget-galaxy']))
o = await order(r.id, 'glow-co-beauty'); await seller(o, 'DISPATCHED', { courierName: 'Delhivery', awb: 'DL55120098' })
o = await order(r.id, 'fitstreet-sports'); await seller(o, 'PACKED')
await shift(r.id, 6)

// 2) 20 × boAt Rockerz — single seller, fully completed
r = await req('technest-retail', 'boAt Rockerz 450 Bluetooth Headphones', 20, { brand: 'boAt', categoryId: cat['Electronics'], targetPrice: 1350 })
await quote(r.id, 'gadget-galaxy', 20, 1280, 'NEW', 2)
await quote(r.id, 'fitstreet-sports', 12, 1310, 'NEW', 3)
await b2b.award(r.id, [{ quoteId: (await query(`SELECT id FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [r.id, V['gadget-galaxy']])).rows[0].id, quantity: 20 }], A(V['technest-retail']))
await b2b.pay(r.id, { method: 'ONLINE' }, A(V['technest-retail']))
o = await order(r.id, 'gadget-galaxy'); await seller(o, 'DISPATCHED', { courierName: 'Delhivery', awb: 'DL90021177' }); await b2b.receive(o.id, { receivedQuantity: 20, ok: true }, A(V['technest-retail']))
await shift(r.id, 12)

// 3) 10 × Philips mixer — split, one short delivery under dispute, one resolved partially
r = await req('kitchen-kart-india', 'Philips Daily Collection Mixer Grinder', 10, { brand: 'Philips', categoryId: cat['Home & Kitchen'], targetPrice: 2900 })
await quote(r.id, 'technest-retail', 6, 2850, 'NEW', 3)
await quote(r.id, 'ethnic-elegance', 4, 2790, 'REFURBISHED', 4, 'Refurbished with 6-month warranty')
await quote(r.id, 'pageturner-books', 10, 3000, 'NEW', 6)
const qid = async (rid, vendor) => (await query(`SELECT id FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [rid, V[vendor]])).rows[0].id
await b2b.award(r.id, [{ quoteId: await qid(r.id, 'technest-retail'), quantity: 6 }, { quoteId: await qid(r.id, 'ethnic-elegance'), quantity: 4 }], A(V['kitchen-kart-india']))
await b2b.pay(r.id, { method: 'ONLINE' }, A(V['kitchen-kart-india']))
o = await order(r.id, 'technest-retail'); await seller(o, 'DISPATCHED', { courierName: 'Blue Dart', awb: 'BD11223344' }); await b2b.receive(o.id, { receivedQuantity: 6, ok: true }, A(V['kitchen-kart-india']))
o = await order(r.id, 'ethnic-elegance'); await seller(o, 'DISPATCHED', { courierName: 'DTDC', awb: 'DT66001122' }); await b2b.receive(o.id, { receivedQuantity: 3, ok: false, note: 'Only 3 of 4 units arrived and one has a cracked jar' }, A(V['kitchen-kart-india']))
await shift(r.id, 9)

// 4) 8 × Redmi — dispute resolved with a partial release
r = await req('gadget-galaxy', 'Redmi 12 5G (8GB/256GB)', 8, { brand: 'Redmi', categoryId: cat['Electronics'], targetPrice: 12500 })
await quote(r.id, 'technest-retail', 8, 12400, 'NEW', 2)
await b2b.award(r.id, [{ quoteId: await qid(r.id, 'technest-retail'), quantity: 8 }], A(V['gadget-galaxy']))
await b2b.pay(r.id, { method: 'ONLINE' }, A(V['gadget-galaxy']))
o = await order(r.id, 'technest-retail'); await seller(o, 'DISPATCHED', { courierName: 'Delhivery', awb: 'DL77889900' }); await b2b.receive(o.id, { receivedQuantity: 6, ok: false, note: '2 handsets were missing from the carton' }, A(V['gadget-galaxy']))
await b2b.resolveDispute(o.id, { decision: 'PARTIAL', releaseQuantity: 6, note: 'Seller confirmed 2 units short — released for 6, 2 refunded to buyer' }, ADMIN)
await shift(r.id, 15)

// 5) 6 × Noise smartwatch — awarded, payment pending
r = await req('technest-retail', 'Noise ColorFit Pulse Smartwatch', 6, { brand: 'Noise', categoryId: cat['Electronics'], targetPrice: 1900 })
await quote(r.id, 'gadget-galaxy', 6, 1850, 'NEW', 2)
await b2b.award(r.id, [{ quoteId: await qid(r.id, 'gadget-galaxy'), quantity: 6 }], A(V['technest-retail']))
await shift(r.id, 1)

// 6) Open requirements with competing quotes
r = await req('fitstreet-sports', 'Yonex Mavis 350 Nylon Shuttle (tube of 6)', 40, { brand: 'Yonex', categoryId: cat['Sports & Fitness'], targetPrice: 850 })
await quote(r.id, 'pageturner-books', 25, 860, 'NEW', 4); await quote(r.id, 'technest-retail', 40, 870, 'NEW', 3)
await shift(r.id, 2)
r = await req('gadget-galaxy', 'Samsung Galaxy S23 256GB (used, Grade A)', 12, { brand: 'Samsung', categoryId: cat['Electronics'], conditionPref: 'USED_OR_REFURBISHED', targetPrice: 31000 })
await quote(r.id, 'technest-retail', 5, 30500, 'USED_LIKE_NEW', 2, 'Battery health 90%+, with box'); await quote(r.id, 'fitstreet-sports', 3, 29800, 'USED_GOOD', 3)
await shift(r.id, 1)
r = await req(null, 'Anker 20W USB-C Fast Charger', 50, { brand: 'Anker', categoryId: cat['Electronics'], targetPrice: 1250, description: 'Stock for the Dealker Official store.' })
await quote(r.id, 'gadget-galaxy', 30, 1230, 'NEW', 2); await quote(r.id, 'technest-retail', 50, 1245, 'NEW', 3); await quote(r.id, 'fitstreet-sports', 20, 1220, 'NEW', 4)
r = await req('kitchen-kart-india', 'Prestige Svachh 3L Pressure Cooker', 18, { brand: 'Prestige', categoryId: cat['Home & Kitchen'] })

// 7) Cancelled and expired
r = await req('pageturner-books', 'Classmate Notebook Pack of 6', 200, { categoryId: cat['Books & Stationery'] })
await b2b.cancelRequirement(r.id, A(V['pageturner-books']), 'Found stock locally')
await shift(r.id, 8)
r = await req('glow-co-beauty', 'Dove Intense Repair Shampoo 650ml', 60, { categoryId: cat['Beauty'] })
await query(`UPDATE b2b_requirements SET response_deadline = NOW() - interval '1 day' WHERE id=$1`, [r.id])
await shift(r.id, 7)

const s = await b2b.stats()
console.log('✅ B2B demo ready', s)
process.exit(0)
