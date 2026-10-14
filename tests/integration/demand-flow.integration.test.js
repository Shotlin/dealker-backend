/**
 * Vendor demand flow (migration 207) — HTTP layer + real Postgres.
 *
 *   DEMAND_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=demand_scratch DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   npx vitest run tests/integration/demand-flow.integration.test.js
 * The target database must already be fully migrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'

const d = process.env.DEMAND_TEST_DB ? describe : describe.skip

d('vendor demand flow (real database)', () => {
  let app, q, listings
  const V = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const letters = () => Array.from({ length: 5 }, () => 'abcdefghij'[Math.floor(Math.random() * 10)]).join('')
  const brand = `Zor${letters()}`
  const model = `${brand} X13`
  const hdr = (v) => ({ authorization: `Bearer ${v.token}` })
  const call = async (v, method, url, payload) => {
    const res = await app.inject({ method, url: `/api/v1/vendor/b2b${url}`, headers: hdr(v), payload })
    return { status: res.statusCode, body: res.json() }
  }
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString()
  const balance = async (v) => Number((await q(`SELECT COALESCE(SUM(amount),0) b FROM settlement_ledger WHERE vendor_id=$1`, [v.id])).rows[0].b)
  const credit = (v, amount) => q(
    `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, idempotency_key) VALUES ($1,'ADJUSTMENT',$2,$3,'test credit',$4)`,
    [v.id, amount, amount + 0, `t:${rand()}`])
  const mkVendor = async (name) => {
    const n = rand()
    const { rows } = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [name, `d-${n}`, `d${n}@t.io`, `7${n}`])
    const u = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id, session_version`, [`9${rand()}`, `${name} user`])).rows[0]
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [rows[0].id, u.id])
    await q(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ($1,$2,$3,'12 MG Road','Delhi','Delhi','110001',28.6,77.2,$4,5,true)`, [`${name} Shop`, `ds-${n}`, `D${n.slice(0, 6)}`, rows[0].id])
    return { id: rows[0].id, userId: u.id, name, token: jwt.sign({ id: u.id, role: 'CUSTOMER', session_version: u.session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkListing = async (v, over = {}) => {
    const cat = (await q(`SELECT id FROM categories LIMIT 1`)).rows[0] ?? (await q(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, [`C${rand()}`, `c-${rand()}`])).rows[0]
    const l = await listings.create({
      name: model, brand, categoryId: cat.id, condition: 'REFURBISHED', stock: 6, specifications: { storage: '128GB' },
      images: ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg'], sellB2c: false, sellB2b: true, wholesalePrice: 29500, moq: 2, ...over,
    }, { vendorId: v.id, actorId: v.userId })
    await q(`UPDATE shop_products SET approval_status='APPROVED', listing_status='ACTIVE' WHERE id=$1`, [l.id])
    return l
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    V.buyer = await mkVendor('Demand Buyer')
    V.sellerA = await mkVendor('Seller A (has stock)')
    V.sellerB = await mkVendor('Seller B (no stock)')
    V.sellerC = await mkVendor('Seller C (Pro only)')
    V.listingA = await mkListing(V.sellerA, { batteryHealth: 88 })
    V.listingC = await mkListing(V.sellerC, { name: `${model} Pro` })
    // The database may hold demand from earlier runs, so counts are asserted as changes from this baseline.
    V.s0 = { A: (await call(V.sellerA, 'GET', '/demand/summary')).body.data, B: (await call(V.sellerB, 'GET', '/demand/summary')).body.data }
  }, 90000)
  afterAll(async () => { await app?.close() })

  const post = (over = {}) => call(V.buyer, 'POST', '/requirements', {
    productName: `${model} 128GB`, brand, quantity: 50, targetPrice: 29000, targetPriceMax: 30000, minBatteryHealth: 85, displayPref: 'ORIGINAL',
    conditionPref: 'USED_OR_REFURBISHED', fulfilmentPref: 'ANY', deliveryCity: 'Delhi NCR', responseDeadline: inDays(2), isUrgent: true,
    description: 'Good working condition.', ...over,
  })

  it('stores what the buyer asked for, derives storage + model key, and validates the rest', async () => {
    const res = await post()
    expect(res.status).toBe(201)
    V.req = res.body.data
    expect(V.req).toMatchObject({ storage: '128GB', target_price_max: '30000.00', min_battery_health: 85, display_pref: 'ORIGINAL', is_urgent: true, fulfilment_pref: 'ANY' })
    expect(V.req.model_key).toBe(`${model.toLowerCase().replace(`${brand.toLowerCase()} `, '')}`)

    expect((await post({ targetPriceMax: 100 })).body.message).toMatch(/Maximum price cannot be lower/)
    expect((await post({ minBatteryHealth: 150 })).status).toBe(400)
    expect((await post({ displayPref: 'SHINY' })).status).toBe(400)
    expect((await post({ responseDeadline: inDays(-1) })).body.message).toMatch(/future/)
  })

  it('the vendor holding matching stock gets a personal alert; the Pro-only vendor and the stock-less vendor get the generic one', async () => {
    const title = async (v) => (await q(`SELECT title, body, data FROM notifications WHERE user_id=$1 AND type='B2B' ORDER BY created_at DESC LIMIT 1`, [v.userId])).rows[0]
    const a = await title(V.sellerA)
    expect(a.title).toMatch(/^Match found: you have 6 ×/)
    expect(a.data).toMatchObject({ requirementId: V.req.id, match: true, matchStock: 6 })
    expect((await title(V.sellerB)).title).toBe('Urgent buying requirement')
    expect((await title(V.sellerC)).title).toBe('Urgent buying requirement') // "X13 Pro" is a different phone
    expect(await title(V.buyer)).toBeUndefined()                              // the poster is never notified of their own post
  })

  it('shows demand to sellers: new / matched counts, and "Match Found" with what they can supply and earn', async () => {
    const s = (await call(V.sellerA, 'GET', '/demand/summary')).body.data
    expect([s.open - V.s0.A.open, s.new - V.s0.A.new, s.matched - V.s0.A.matched, s.urgent - V.s0.A.urgent]).toEqual([1, 1, 1, 1])
    const sb = (await call(V.sellerB, 'GET', '/demand/summary')).body.data
    expect([sb.open - V.s0.B.open, sb.new - V.s0.B.new, sb.matched - V.s0.B.matched]).toEqual([1, 1, 0])

    const list = (await call(V.sellerA, 'GET', `/requirements?scope=matched&search=${brand}`)).body
    expect(list.data.map((r) => r.id)).toEqual([V.req.id])
    expect(list.data[0]).toMatchObject({ tags: ['URGENT', 'BULK'], my_match: { level: 'EXACT', stock: 6 }, viewed: false })
    expect((await call(V.sellerB, 'GET', `/requirements?scope=matched&search=${brand}`)).body.data).toEqual([])
    expect(list.data[0].quote_count).toBeUndefined() // quotes are sealed from other vendors

    const m = (await call(V.sellerA, 'GET', `/requirements/${V.req.id}/match`)).body.data
    expect(m).toMatchObject({ level: 'EXACT', totalStock: 6, canSupply: 6, remaining: 50, commissionPercent: 10 })
    expect(m.listings).toHaveLength(1)
    expect(m.listings[0]).toMatchObject({ id: V.listingA.id, level: 'EXACT', stock: 6, battery_health: 88, suggested_price: 29500, storage: '128GB' })
    expect(m.suggested).toMatchObject({ listingId: V.listingA.id, unitPrice: 29500, quantity: 6 })
  })

  it('a requirement is "new" until the vendor opens it; "Not interested" hides it', async () => {
    expect((await call(V.sellerA, 'GET', `/requirements/${V.req.id}`)).status).toBe(200)
    expect((await call(V.sellerA, 'GET', '/demand/summary')).body.data.new).toBe(V.s0.A.new)
    expect((await call(V.sellerA, 'GET', `/requirements?scope=open&search=${brand}`)).body.data[0].viewed).toBe(true)

    expect((await call(V.sellerB, 'POST', `/requirements/${V.req.id}/dismiss`)).status).toBe(200)
    expect((await call(V.sellerB, 'GET', `/requirements?scope=open&search=${brand}`)).body.data).toEqual([])
    expect((await call(V.sellerB, 'GET', '/demand/summary')).body.data.open).toBe(V.s0.B.open)
  })

  it('an offer goes Pending → Viewed when the buyer opens it, and counts under the right tab', async () => {
    const bad = await call(V.sellerA, 'POST', `/requirements/${V.req.id}/quote`, { quantity: 99, unitPrice: 29500 })
    expect(bad.status).toBe(400)
    const stranger = await call(V.sellerA, 'POST', `/requirements/${V.req.id}/quote`, { quantity: 6, unitPrice: 29500, listingId: V.listingC.id })
    expect(stranger.status).toBe(400)

    const ok = await call(V.sellerA, 'POST', `/requirements/${V.req.id}/quote`, { quantity: 6, unitPrice: 29500, condition: 'REFURBISHED', deliveryDays: 2, listingId: V.listingA.id, note: 'Box packed' })
    expect(ok.status).toBe(200)
    V.quoteA = ok.body.data
    expect((await call(V.sellerA, 'GET', '/requirements?scope=quoted&tab=pending')).body.data[0]).toMatchObject({ offer_state: 'PENDING', id: V.req.id })
    expect((await call(V.sellerA, 'GET', '/demand/summary')).body.data.offers).toMatchObject({ active: 1, pending: 1, closed: 0 })
    expect((await call(V.sellerA, 'GET', `/requirements?scope=new&search=${brand}`)).body.data).toEqual([]) // already quoted

    const sellerB = await call(V.sellerB, 'POST', `/requirements/${V.req.id}/quote`, { quantity: 20, unitPrice: 29800, condition: 'REFURBISHED' })
    expect(sellerB.status).toBe(200)
    V.quoteB = sellerB.body.data

    const detail = (await call(V.buyer, 'GET', `/requirements/${V.req.id}`)).body.data
    expect(detail.quotes.map((x) => x.seller_name)).toEqual(['Seller A (has stock)', 'Seller B (no stock)']) // cheapest first
    expect(detail.quotes[0]).toMatchObject({ seller_city: 'Delhi', quantity_offered: 6 })
    expect((await call(V.sellerA, 'GET', '/requirements?scope=quoted&tab=active')).body.data[0].offer_state).toBe('VIEWED')
    // Changing the price makes the buyer look again.
    await call(V.sellerA, 'POST', `/requirements/${V.req.id}/quote`, { quantity: 6, unitPrice: 29400, condition: 'REFURBISHED' })
    expect((await call(V.sellerA, 'GET', '/requirements?scope=quoted&tab=active')).body.data[0].offer_state).toBe('PENDING')
    await call(V.buyer, 'GET', `/requirements/${V.req.id}`)
  })

  it('paying: only the wallet works for vendors, a short wallet is refused with the shortfall, a funded one is debited into escrow', async () => {
    const award = await call(V.buyer, 'POST', `/requirements/${V.req.id}/award`, { selections: [{ quoteId: V.quoteA.id, quantity: 6 }, { quoteId: V.quoteB.id, quantity: 14 }] })
    expect(award.status).toBe(200)
    V.orders = award.body.data
    const total = 6 * 29400 + 14 * 29800
    expect(total).toBe(593600)
    expect((await call(V.sellerA, 'GET', '/demand/summary')).body.data.offers.accepted).toBe(1)

    expect((await call(V.sellerA, 'POST', `/requirements/${V.req.id}/pay`, {})).status).toBe(403) // only the buyer
    const upi = await call(V.buyer, 'POST', `/requirements/${V.req.id}/pay`, { method: 'ONLINE', reference: 'fake-upi-ref' })
    expect(upi.status).toBe(400)
    expect(upi.body.code).toBe('METHOD_UNAVAILABLE')

    await credit(V.buyer, 500000)
    const short = await call(V.buyer, 'POST', `/requirements/${V.req.id}/pay`, { method: 'WALLET' })
    expect(short.status).toBe(402)
    expect(short.body).toMatchObject({ code: 'INSUFFICIENT_WALLET', required: total, balance: 500000, shortfall: total - 500000 })
    expect((await call(V.buyer, 'GET', '/wallet')).body.data).toMatchObject({ balance: 500000, onHold: false })

    await credit(V.buyer, 200000)
    const paid = await call(V.buyer, 'POST', `/requirements/${V.req.id}/pay`, { method: 'WALLET' })
    expect(paid.status).toBe(200)
    expect(paid.body.data).toMatchObject({ method: 'WALLET', amount: total })
    expect(await balance(V.buyer)).toBe(700000 - total)
    const led = (await q(`SELECT amount, reason_code, reference_type FROM settlement_ledger WHERE vendor_id=$1 ORDER BY id DESC LIMIT 1`, [V.buyer.id])).rows[0]
    expect(led).toMatchObject({ reason_code: 'B2B_PURCHASE', reference_type: 'B2B_ORDER' })
    expect(Number(led.amount)).toBe(-total)
    expect((await call(V.buyer, 'POST', `/requirements/${V.req.id}/pay`, { method: 'WALLET' })).body.code).toBe('NOTHING_TO_PAY') // no double charge
    expect((await q(`SELECT status, payment_status, payment_method FROM b2b_orders WHERE requirement_id=$1`, [V.req.id])).rows.every((o) => o.status === 'PAID' && o.payment_status === 'ESCROW_HELD' && o.payment_method === 'WALLET')).toBe(true)
  })

  it('fulfilment: pickup needs a slot, courier needs an AWB; order tracking reveals the other side only after payment', async () => {
    const orderA = V.orders.find((o) => o.seller_vendor_id === V.sellerA.id)
    const orderB = V.orders.find((o) => o.seller_vendor_id === V.sellerB.id)
    expect((await call(V.sellerA, 'POST', `/orders/${orderA.id}/status`, { status: 'DISPATCHED', fulfilmentType: 'PICKUP' })).body.message).toMatch(/pickup date/)
    expect((await call(V.sellerB, 'POST', `/orders/${orderB.id}/status`, { status: 'DISPATCHED' })).body.message).toMatch(/Courier name/)
    expect((await call(V.sellerA, 'POST', `/orders/${orderB.id}/status`, { status: 'PACKED' })).status).toBe(404) // not their order

    expect((await call(V.sellerA, 'POST', `/orders/${orderA.id}/status`, { status: 'PACKED' })).status).toBe(200)
    const slot = new Date(Date.now() + 86400000).toISOString()
    expect((await call(V.sellerA, 'POST', `/orders/${orderA.id}/status`, { status: 'DISPATCHED', fulfilmentType: 'PICKUP', pickupAt: slot, pickupNote: 'Ask for Raj' })).status).toBe(200)
    expect((await call(V.sellerB, 'POST', `/orders/${orderB.id}/status`, { status: 'DISPATCHED', courierName: 'Blue Dart', awb: 'BD123', trackingUrl: 'https://t.test/BD123' })).status).toBe(200)

    const view = (await call(V.buyer, 'GET', `/orders/${orderA.id}`)).body.data
    expect(view.order).toMatchObject({ status: 'DISPATCHED', fulfilment_type: 'PICKUP', pickup_note: 'Ask for Raj' })
    expect(view.seller).toMatchObject({ name: 'Seller A (has stock)', city: 'Delhi', address: '12 MG Road' })
    expect(view.seller.phone).toBeTruthy()
    expect(view.payment).toMatchObject({ method: 'WALLET', status: 'HELD' })
    expect(view.events.map((e) => e.type)).toEqual(expect.arrayContaining(['POSTED', 'PAID', 'AWARDED', 'PACKED', 'DISPATCHED']))
    expect((await call(V.sellerB, 'GET', `/orders/${orderA.id}`)).status).toBe(404) // a stranger sees nothing
    expect((await call(V.buyer, 'GET', '/orders?role=buying&bucket=active')).body.data).toHaveLength(2)
    expect((await call(V.sellerA, 'GET', '/orders?role=selling&bucket=done')).body.data).toHaveLength(0)
    expect((await call(V.sellerA, 'GET', '/demand/summary')).body.data.orders).toMatchObject({ to_dispatch: 0, selling_active: 1 })
    expect((await call(V.buyer, 'GET', '/demand/summary')).body.data.orders).toMatchObject({ to_receive: 2, buying_active: 2 })
    expect((await call(V.sellerA, 'POST', `/orders/${orderA.id}/cancel`, { reason: 'changed my mind' })).status).toBe(409) // too late once dispatched
  })

  it('confirming receipt releases the money: seller gets price minus commission, Dealker keeps the commission', async () => {
    const orderA = V.orders.find((o) => o.seller_vendor_id === V.sellerA.id)
    const before = await balance(V.sellerA)
    expect((await call(V.sellerA, 'POST', `/orders/${orderA.id}/receive`, {})).status).toBe(404) // only the buyer can confirm
    expect((await call(V.buyer, 'POST', `/orders/${orderA.id}/receive`, { receivedQuantity: 6, ok: true })).status).toBe(200)
    const gross = 6 * 29400
    expect(await balance(V.sellerA) - before).toBeCloseTo(gross * 0.9, 2)
    const o = (await q(`SELECT status, payment_status, released_amount FROM b2b_orders WHERE id=$1`, [orderA.id])).rows[0]
    expect(o).toMatchObject({ status: 'COMPLETED', payment_status: 'RELEASED' })
    expect(Number(o.released_amount)).toBeCloseTo(gross * 0.9, 2)
    expect((await call(V.buyer, 'POST', `/orders/${orderA.id}/receive`, {})).status).toBe(409) // cannot be released twice
  })

  it('a short delivery becomes a dispute; a partial resolution pays for what arrived and refunds the rest to the buyer', async () => {
    const orderB = V.orders.find((o) => o.seller_vendor_id === V.sellerB.id)
    const buyerBefore = await balance(V.buyer)
    expect((await call(V.buyer, 'POST', `/orders/${orderB.id}/receive`, { receivedQuantity: 10, note: 'Only 10 boxes came' })).status).toBe(200)
    expect((await q(`SELECT status FROM b2b_orders WHERE id=$1`, [orderB.id])).rows[0].status).toBe('DISPUTED')
    expect((await q(`SELECT title FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [V.sellerB.userId])).rows[0].title).toBe('Buyer reported an issue')

    const { b2b } = await import('../../src/modules/b2b/b2b.service.js')
    await b2b.resolveDispute(orderB.id, { decision: 'PARTIAL', releaseQuantity: 10, note: 'Short shipment' }, { label: 'Dealker admin', isAdmin: true })
    expect(await balance(V.buyer) - buyerBefore).toBe(4 * 29800)
    const o = (await q(`SELECT status, released_amount FROM b2b_orders WHERE id=$1`, [orderB.id])).rows[0]
    expect(o.status).toBe('COMPLETED')
    expect(Number(o.released_amount)).toBeCloseTo(10 * 29800 * 0.9, 2)
    // Re-running the refund must not pay the buyer twice.
    await expect(b2b.resolveDispute(orderB.id, { decision: 'REFUND' }, { isAdmin: true })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })

  it('a seller who cannot deliver cancels a paid order: buyer is refunded in full and the units are open for offers again', async () => {
    const r2 = (await post({ isUrgent: false, quantity: 10 })).body.data
    const q1 = (await call(V.sellerA, 'POST', `/requirements/${r2.id}/quote`, { quantity: 10, unitPrice: 30000, condition: 'REFURBISHED' })).body.data
    const [o] = (await call(V.buyer, 'POST', `/requirements/${r2.id}/award`, { selections: [{ quoteId: q1.id, quantity: 10 }] })).body.data
    await credit(V.buyer, 400000)
    const before = await balance(V.buyer)
    expect((await call(V.buyer, 'POST', `/requirements/${r2.id}/pay`, { method: 'WALLET' })).status).toBe(200)
    expect(await balance(V.buyer)).toBe(before - 300000)

    expect((await call(V.sellerA, 'POST', `/orders/${o.id}/cancel`, { reason: '' })).status).toBe(400)
    const cancelled = await call(V.sellerA, 'POST', `/orders/${o.id}/cancel`, { reason: 'Stock sold in store' })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data.refunded).toBe(300000)
    expect(await balance(V.buyer)).toBe(before)
    const row = (await q(`SELECT status, payment_status FROM b2b_orders WHERE id=$1`, [o.id])).rows[0]
    expect(row).toMatchObject({ status: 'CANCELLED', payment_status: 'REFUNDED' })
    const req = (await q(`SELECT status, quantity_awarded FROM b2b_requirements WHERE id=$1`, [r2.id])).rows[0]
    expect(req).toMatchObject({ status: 'OPEN', quantity_awarded: 0 })
    expect((await q(`SELECT status FROM b2b_quotes WHERE id=$1`, [q1.id])).rows[0].status).toBe('WITHDRAWN')
    expect((await call(V.sellerA, 'POST', `/orders/${o.id}/cancel`, { reason: 'again' })).status).toBe(409)
    expect(await balance(V.buyer)).toBe(before) // no second refund
  })

  it('the dashboard sees demand: funnel, top models and requests nobody answered', async () => {
    const lonely = (await post({ productName: `${brand} Lonely9 64GB`, quantity: 3, isUrgent: false })).body.data
    await q(`UPDATE b2b_requirements SET created_at = NOW() - interval '5 hours' WHERE id=$1`, [lonely.id])
    const { b2b } = await import('../../src/modules/b2b/b2b.service.js')
    const ins = await b2b.demandInsights({ days: 30 })
    expect(ins.funnel.posted).toBeGreaterThanOrEqual(3)
    expect(ins.funnel.quoted).toBeGreaterThanOrEqual(2)
    expect(ins.funnel.paid).toBeGreaterThanOrEqual(2)
    expect(ins.funnel.fill_rate).toBeGreaterThan(0)
    const top = ins.topModels.find((t) => t.model === V.req.model_key)
    expect(top).toBeTruthy()
    expect(top.requests).toBeGreaterThanOrEqual(2)
    expect(top.units_needed).toBeGreaterThanOrEqual(60)
    expect(ins.unserved.map((u) => u.id)).toContain(lonely.id)
    expect(ins.reach.vendors_viewed).toBeGreaterThanOrEqual(1)
    const list = await b2b.adminRequirements({ search: brand, limit: 50 })
    expect(list.data[0]).toHaveProperty('view_count')
  })
})
