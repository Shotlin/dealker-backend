/**
 * Sell requests — integration tests against a REAL Postgres.
 *
 * Opt-in:
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5440 DB_NAME=sell_test DB_USER=t DB_PASSWORD=t \
 *   npx vitest run tests/integration/sell-requests.integration.test.js
 * The target database must already be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.SELL_TEST_DB ? describe : describe.skip

d('sell requests (real database)', () => {
  let q, pool, svc
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const admin = () => ({ kind: 'ADMIN', scopeKind: 'SELL', userId: F.adminId, vendorId: null })
  const vendorA = () => ({ kind: 'VENDOR', scopeKind: 'SELL', userId: F.vUserA, vendorId: F.vendorA })
  const vendorB = () => ({ kind: 'VENDOR', scopeKind: 'SELL', userId: F.vUserB, vendorId: F.vendorB })
  // the Exchange section
  const adminX = () => ({ ...admin(), scopeKind: 'EXCHANGE' })
  const vendorAX = () => ({ ...vendorA(), scopeKind: 'EXCHANGE' })
  const custS = (userId = F.cust) => ({ kind: 'CUSTOMER', scopeKind: 'SELL', userId })
  const custX = (userId = F.cust) => ({ kind: 'CUSTOMER', scopeKind: 'EXCHANGE', userId })

  const qa = { ageMonths: 12, screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 90, powersOn: true }
  let imeiSeq = 0
  const imei = () => {
    // Build a Luhn-valid 15-digit IMEI deterministically
    const body = String(35000000000000 + Date.now() % 1e7 * 10 + (imeiSeq++)).slice(0, 14)
    for (let c = 0; c < 10; c++) {
      const s = body + c
      let sum = 0
      for (let i = 0; i < 15; i++) { let n = Number(s[14 - i]); if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n }
      if (sum % 10 === 0) return s
    }
  }
  const input = (over = {}) => ({ type: 'SELL_TO_AB', model: 'iPhone 14', variant: '128GB', color: 'White', imei: imei(), qa, customer: { name: 'Walk In', phone: `+91 9${rand()}` }, ...over })

  const mkUser = async (name) => (await q(`INSERT INTO users (phone, name) VALUES ($1,$2) RETURNING id`, [`9${rand()}`, name])).rows[0].id
  const mkVendor = async (name) => {
    const n = rand()
    return (await q(`INSERT INTO vendors (name, slug, email, phone, status, is_active) VALUES ($1,$2,$3,$4,'ACTIVE',TRUE) RETURNING id`, [name, `v-${n}`, `v${n}@x.test`, `8${n}`])).rows[0].id
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query
    pool = db.pool
    svc = await import('../../src/modules/sell-requests/sell-requests.service.js')
    F.adminId = await mkUser('Admin'); F.cust = await mkUser('Rohit Kumar')
    F.vUserA = await mkUser('VA'); F.vUserB = await mkUser('VB')
    F.vendorA = await mkVendor('Vendor A'); F.vendorB = await mkVendor('Vendor B')
  })
  afterAll(async () => { await pool.end() })

  it('server computes the quote and ignores any client-supplied value', async () => {
    const r = await svc.createRequest(admin(), input({ quote: 999999, status: 'APPROVED' }))
    expect(r.status).toBe('PENDING')
    expect(r.quote).toBeGreaterThan(0)
    expect(r.quote).toBeLessThan(46000)
    expect(r.condition).toBe('EXCELLENT') // 12 months = 5% deduction, inside the 8% band
    expect(r.deductions.length).toBeGreaterThan(0)
    expect(r.timeline[0].label).toBe('Request Submitted')
  })

  it('rejects a bad IMEI, unknown model/variant and bad QA', async () => {
    await expect(svc.createRequest(admin(), input({ imei: '123456789012345' }))).rejects.toMatchObject({ code: 'INVALID_IMEI' })
    await expect(svc.createRequest(admin(), input({ model: 'Nokia 3310' }))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    await expect(svc.createRequest(admin(), input({ variant: '1TB' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.createRequest(admin(), input({ qa: { ...qa, ageMonths: -4 } }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('allows only one live request per IMEI, and frees it after cancellation', async () => {
    const i = imei()
    const a = await svc.createRequest(admin(), input({ imei: i }))
    await expect(svc.createRequest(admin(), input({ imei: i }))).rejects.toMatchObject({ code: 'IMEI_ACTIVE', statusCode: 409 })
    await svc.cancel(admin(), a.id, 'duplicate')
    await expect(svc.createRequest(admin(), input({ imei: i }))).resolves.toMatchObject({ status: 'PENDING' })
  })

  it('customer creates under their own account and only sees their own requests', async () => {
    const r = await svc.createRequest(custS(), input({ customer: { name: 'Hacker', phone: '+91 0000000000' } }))
    expect(r.customer.name).toBe('Rohit Kumar') // identity comes from the account, not the body
    const other = await mkUser('Other')
    await expect(svc.getMine(other, r.id, 'SELL')).rejects.toMatchObject({ statusCode: 404 })
    expect((await svc.getMine(F.cust, r.id, 'SELL')).id).toBe(r.id)
    expect((await svc.mine(F.cust, 'SELL')).data.total).toBeGreaterThanOrEqual(1)
    await expect(svc.cancel(custS(other), r.id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('only accepts images from our own upload endpoint', async () => {
    const ok = 'http://localhost:4500/uploads/2026-10/abc.jpg'
    const r = await svc.createRequest(admin(), input({ images: [ok, ok] }))
    expect(r.images).toEqual([ok]) // de-duplicated
    for (const bad of ['https://evil.example.com/a.jpg', 'javascript:alert(1)', 'http://localhost:4500/uploads/../etc/passwd', 42]) {
      await expect(svc.createRequest(admin(), input({ images: [bad] }))).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(svc.createRequest(admin(), input({ images: Array(9).fill(ok) }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('exchange computes trade-in and what the customer pays', async () => {
    const r = await svc.createRequest(adminX(), input({ type: 'EXCHANGE', exchange: { newProduct: 'iPhone 15', newProductPrice: 69900 } }))
    expect(r.exchange.tradeInValue).toBe(r.quote)
    expect(r.exchange.payable).toBe(69900 - r.quote)
    expect(r.code).toMatch(/^EXCH-2\d{5}$/)
    await expect(svc.createRequest(adminX(), input({ type: 'EXCHANGE' }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  describe('offers, assignment and approval', () => {
    let r
    it('vendors bid; each vendor only sees their own offer; best offer assigned', async () => {
      r = await svc.createRequest(admin(), input())
      await svc.placeOffer(vendorA(), r.id, { amount: 30000, distanceKm: 4 })
      await svc.placeOffer(vendorB(), r.id, { amount: 33000 })
      // update own offer instead of duplicating
      const upd = await svc.placeOffer(vendorA(), r.id, { amount: 31000 })
      expect(upd.offers).toHaveLength(1)
      expect(upd.offers[0].amount).toBe(31000)
      const asAdmin = await svc.getManage(admin(), r.id)
      expect(asAdmin.offers.map((o) => o.amount)).toEqual([33000, 31000])
      // vendor view masks the customer
      const vv = await svc.getManage(vendorA(), r.id)
      expect(vv.customer.phone).toContain('•')
      expect(vv.adminNote).toBeUndefined()
    })

    it('cannot approve before a vendor is assigned', async () => {
      await expect(svc.approve(admin(), r.id)).rejects.toMatchObject({ code: 'NO_VENDOR' })
    })

    it('assign accepts one offer and declines the rest', async () => {
      const a = await svc.assignVendor(admin(), r.id, F.vendorB)
      expect(a.status).toBe('IN_PROGRESS')
      expect(a.assignedVendor).toBe('Vendor B')
      expect(a.finalPrice).toBe(33000)
      expect(a.offers.find((o) => o.vendorId === F.vendorA).status).toBe('DECLINED')
      await expect(svc.placeOffer(vendorA(), r.id, { amount: 32000 })).rejects.toMatchObject({ code: 'ALREADY_ASSIGNED' })
    })

    it('after assignment the other vendor loses visibility; assigned vendor sees contact details', async () => {
      await expect(svc.getManage(vendorA(), r.id)).rejects.toMatchObject({ statusCode: 404 })
      const vb = await svc.getManage(vendorB(), r.id)
      expect(vb.customer.phone).not.toContain('•')
    })

    it('approve → complete, with a guarded state machine', async () => {
      const ap = await svc.approve(admin(), r.id)
      expect(ap.status).toBe('APPROVED')
      await expect(svc.reject(admin(), r.id, 'no')).rejects.toMatchObject({ code: 'INVALID_STATE' })
      const done = await svc.complete(admin(), r.id)
      expect(done.status).toBe('COMPLETED')
      expect(done.timeline.every((t) => t.done)).toBe(true)
      await expect(svc.cancel(admin(), r.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    })

    it('reject needs a reason and declines open offers', async () => {
      const x = await svc.createRequest(admin(), input())
      await svc.placeOffer(vendorA(), x.id, { amount: 20000 })
      await expect(svc.reject(admin(), x.id, '  ')).rejects.toMatchObject({ code: 'VALIDATION' })
      const rj = await svc.reject(admin(), x.id, 'Blacklisted IMEI')
      expect(rj.status).toBe('REJECTED')
      expect(rj.offers[0].status).toBe('DECLINED')
    })

    it('rejects absurd offers and offers from inactive vendors', async () => {
      const x = await svc.createRequest(admin(), input())
      await expect(svc.placeOffer(vendorA(), x.id, { amount: 10_000_000 })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(svc.placeOffer(vendorA(), x.id, { amount: -5 })).rejects.toMatchObject({ code: 'VALIDATION' })
      await q(`UPDATE vendors SET status='SUSPENDED' WHERE id=$1`, [F.vendorA])
      await expect(svc.placeOffer(vendorA(), x.id, { amount: 20000 })).rejects.toMatchObject({ code: 'VENDOR_NOT_ACTIVE' })
      await q(`UPDATE vendors SET status='ACTIVE' WHERE id=$1`, [F.vendorA])
    })

    it('withdraw removes an open offer and blocks assigning it', async () => {
      const x = await svc.createRequest(admin(), input())
      await svc.placeOffer(vendorA(), x.id, { amount: 20000 })
      await svc.withdrawOffer(vendorA(), x.id)
      await expect(svc.assignVendor(admin(), x.id, F.vendorA)).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' })
    })
  })

  it('concurrent approve + reject: exactly one wins', async () => {
    const x = await svc.createRequest(admin(), input())
    await svc.placeOffer(vendorA(), x.id, { amount: 20000 })
    await svc.assignVendor(admin(), x.id, F.vendorA)
    const res = await Promise.allSettled([svc.approve(admin(), x.id), svc.reject(admin(), x.id, 'race')])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const final = await svc.getManage(admin(), x.id)
    expect(['APPROVED', 'REJECTED']).toContain(final.status)
  })

  it('list: tabs, counts, filters, search and pagination', async () => {
    const all = (await svc.listManage(admin(), { limit: 5 })).data
    expect(all.items).toHaveLength(5)
    expect(all.pages).toBe(Math.ceil(all.total / 5))
    expect(all.counts.all).toBe(all.total)
    const pend = (await svc.listManage(admin(), { status: 'pending', limit: 100 })).data
    expect(pend.items.every((i) => i.status === 'PENDING')).toBe(true)
    expect(pend.total).toBe(all.counts.pending)
    const byImei = (await svc.listManage(admin(), { q: all.items[0].device.imei })).data
    expect(byImei.items[0].id).toBe(all.items[0].id)
    const laptops = (await svc.listManage(admin(), { category: 'Laptop' })).data
    const dbLaptops = (await q(`SELECT COUNT(*)::int n FROM sell_requests WHERE category='Laptop'`)).rows[0].n
    expect(laptops.total).toBe(dbLaptops)
    expect(laptops.items.every((i) => i.device.category === 'Laptop')).toBe(true)
    await expect(svc.listManage(admin(), { status: 'bogus' })).rejects.toMatchObject({ code: 'VALIDATION' })
    // search is parameterised — injection attempts return nothing, not errors
    await expect(svc.listManage(admin(), { q: "'; DROP TABLE sell_requests;--" })).resolves.toBeTruthy()
  })

  it('vendor list only shows open or own-assigned requests', async () => {
    const list = (await svc.listManage(vendorA(), { limit: 100 })).data
    for (const i of list.items) {
      const row = (await q('SELECT status, assigned_vendor_id FROM sell_requests WHERE id=$1', [i.id])).rows[0]
      expect(row.assigned_vendor_id === F.vendorA || (row.assigned_vendor_id === null && ['PENDING', 'IN_PROGRESS'].includes(row.status))).toBe(true)
    }
  })

  it('stats reflect the table', async () => {
    const s = await svc.stats(admin())
    const { rows } = await q(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE status='PENDING')::int p FROM sell_requests WHERE kind='SELL'`)
    expect(s.total).toBe(rows[0].n)
    expect(s.pending).toBe(rows[0].p)
  })

  it('catalogue CRUD validates input', async () => {
    const name = `Test Phone ${rand()}`
    const m = await svc.createModel({ name, category: 'Smartphone', variants: ['64GB', '128GB'], colors: ['Black'], basePrice: 15000 })
    await expect(svc.createModel({ name, category: 'Smartphone', variants: ['64GB'], colors: ['Black'], basePrice: 1 })).rejects.toMatchObject({ code: 'MODEL_EXISTS' })
    await expect(svc.createModel({ name: 'x', category: 'Toaster', variants: ['a'], colors: ['b'], basePrice: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.createModel({ name: 'y', category: 'Tablet', variants: ['a', 'a'], colors: ['b'], basePrice: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await svc.updateModel(m.id, { isActive: false })
    await expect(svc.createRequest(admin(), input({ model: name, variant: '64GB', color: 'Black' }))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('settings overrides change quotes; unknown rules are refused', async () => {
    const before = (await svc.quote(input())).value
    await svc.updateSettings(admin(), { rules: { ageFreeMonths: 24 } })
    const after = (await svc.quote(input())).value
    expect(after).toBeGreaterThan(before)
    await expect(svc.updateSettings(admin(), { rules: { hackMe: 1 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await svc.updateSettings(admin(), { rules: {} })
  })

  describe('exchange → order linkage', () => {
    const mkOrder = async (userId, status = 'ORDER_PLACED') => {
      const num = `T-${rand()}`
      const { rows } = await q(`INSERT INTO orders (order_number, customer_id, items, subtotal, total_payable, delivery_address, status)
                                VALUES ($1,$2,'[]',100,100,'{}',$3) RETURNING id`, [num, userId, status])
      return { id: rows[0].id, num }
    }
    const approvedExchange = async (userId = F.cust) => {
      const r = await svc.createRequest(custX(userId), input({ type: 'EXCHANGE', exchange: { newProduct: 'iPhone 15', newProductPrice: 70000 } }))
      await svc.placeOffer(vendorAX(), r.id, { amount: 30000 })
      await svc.assignVendor(adminX(), r.id, F.vendorA)
      await svc.approve(adminX(), r.id)
      return r
    }

    it('cannot complete an exchange until an order is linked', async () => {
      const r = await approvedExchange()
      await expect(svc.complete(adminX(), r.id)).rejects.toMatchObject({ code: 'EXCHANGE_ORDER_REQUIRED' })
      const o = await mkOrder(F.cust)
      const linked = await svc.linkOrder(adminX(), r.id, o.num)
      expect(linked.exchangeOrder).toMatchObject({ id: o.id, orderNumber: o.num })
      expect(linked.timeline.some((t) => t.label.includes(o.num))).toBe(true)
      expect((await svc.complete(adminX(), r.id)).status).toBe('COMPLETED')
    })

    it("refuses another customer's order, a cancelled order, a reused order, and non-exchange requests", async () => {
      const r = await approvedExchange()
      const other = await mkUser('Someone Else')
      await expect(svc.linkOrder(adminX(), r.id, (await mkOrder(other)).num)).rejects.toMatchObject({ code: 'ORDER_MISMATCH' })
      await expect(svc.linkOrder(adminX(), r.id, (await mkOrder(F.cust, 'CANCELLED')).num)).rejects.toMatchObject({ code: 'ORDER_CANCELLED' })
      await expect(svc.linkOrder(adminX(), r.id, 'NOPE-1')).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
      const o = await mkOrder(F.cust)
      await svc.linkOrder(adminX(), r.id, o.num)
      const r2 = await approvedExchange()
      await expect(svc.linkOrder(adminX(), r2.id, o.num)).rejects.toMatchObject({ code: 'ORDER_ALREADY_LINKED' })

      const plain = await svc.createRequest(admin(), input())
      await expect(svc.linkOrder(adminX(), plain.id, o.num)).rejects.toMatchObject({ code: 'NOT_FOUND' }) // sell rows are invisible to the exchange section
    })

    it('links an order while still pending, once only, and needs the customer to have an account', async () => {
      const pending = await svc.createRequest(custX(), input({ type: 'EXCHANGE', exchange: { newProduct: 'x', newProductPrice: 70000 } }))
      const o1 = await mkOrder(F.cust)
      expect((await svc.linkOrder(adminX(), pending.id, o1.num)).exchangeOrder.orderNumber).toBe(o1.num)
      await expect(svc.linkOrder(adminX(), pending.id, (await mkOrder(F.cust)).num)).rejects.toMatchObject({ code: 'ORDER_ALREADY_LINKED' })
      const walkIn = await svc.createRequest(adminX(), input({ type: 'EXCHANGE', exchange: { newProduct: 'x', newProductPrice: 70000 } }))
      await svc.placeOffer(vendorAX(), walkIn.id, { amount: 20000 })
      await svc.assignVendor(adminX(), walkIn.id, F.vendorA)
      await svc.approve(adminX(), walkIn.id)
      await expect(svc.linkOrder(adminX(), walkIn.id, 'whatever')).rejects.toMatchObject({ code: 'NO_CUSTOMER_ACCOUNT' })
    })
  })

  describe('notifications', () => {
    const waitFor = async (fn, ms = 3000) => {
      const end = Date.now() + ms
      while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) }
      return null
    }
    const notesFor = async (userId, event) =>
      (await q(`SELECT title, body, data FROM notifications WHERE user_id=$1 AND data->>'event'=$2`, [userId, event])).rows

    it('customer and vendors are notified along the lifecycle, without leaking customer details to vendors', async () => {
      const vendorUser = F.vUserA
      await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER') ON CONFLICT DO NOTHING`, [F.vendorA, vendorUser])
      await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER') ON CONFLICT DO NOTHING`, [F.vendorB, F.vUserB])

      const r = await svc.createRequest(custS(), input())
      const newForVendor = await waitFor(async () => (await notesFor(vendorUser, 'sell_request:submitted')).find((n) => n.data.requestId === r.id))
      expect(newForVendor).toBeTruthy()
      expect(JSON.stringify(newForVendor)).not.toMatch(/Rohit|9\d{9}/)

      await svc.placeOffer(vendorA(), r.id, { amount: 30000 })
      await svc.placeOffer(vendorB(), r.id, { amount: 29000 })
      await svc.assignVendor(admin(), r.id, F.vendorA)
      await svc.approve(admin(), r.id)

      const mine = async (ev) => waitFor(async () => (await notesFor(F.cust, ev)).find((n) => n.data.requestId === r.id))
      expect((await mine('sell_request:vendor_assigned')).body).toContain('₹30,000')
      expect(await mine('sell_request:approved')).toBeTruthy()
      expect(await waitFor(async () => (await notesFor(vendorUser, 'sell_request:vendor_assigned')).find((n) => n.data.requestId === r.id))).toBeTruthy()
      // the losing vendor is told, the winning vendor is not
      expect(await waitFor(async () => (await notesFor(F.vUserB, 'sell_request:offer_declined')).find((n) => n.data.requestId === r.id))).toBeTruthy()
      await new Promise((r2) => setTimeout(r2, 200))
      expect((await notesFor(vendorUser, 'sell_request:offer_declined')).filter((n) => n.data.requestId === r.id)).toHaveLength(0)
    })

    it('walk-in requests (no account) do not notify a customer and never fail the action', async () => {
      const r = await svc.createRequest(admin(), input())
      await expect(svc.reject(admin(), r.id, 'no')).resolves.toMatchObject({ status: 'REJECTED' })
    })

    it('a customer who cancels is not notified of their own action', async () => {
      const r = await svc.createRequest(custS(), input())
      await svc.cancel(custS(), r.id)
      await new Promise((r2) => setTimeout(r2, 400))
      expect((await notesFor(F.cust, 'sell_request:cancelled')).filter((n) => n.data.requestId === r.id)).toHaveLength(0)
    })
  })

  describe('Sell and Exchange are separate sections', () => {
    let sell, exch
    const mkOrder2 = async (userId) => {
      const num = `T-${rand()}`
      const { rows } = await q(`INSERT INTO orders (order_number, customer_id, items, subtotal, total_payable, delivery_address) VALUES ($1,$2,'[]',100,100,'{}') RETURNING id`, [num, userId])
      return { id: rows[0].id, num }
    }
    const exchangeInput = (over = {}) => input({ type: 'EXCHANGE', exchange: { newProduct: 'Galaxy S24', newProductPrice: 80000 }, ...over })

    beforeAll(async () => {
      sell = await svc.createRequest(admin(), input())
      exch = await svc.createRequest(adminX(), exchangeInput())
    })

    it('uses separate number ranges', () => {
      expect(sell.code).toMatch(/^SELL-1\d{5}$/)
      expect(exch.code).toMatch(/^EXCH-2\d{5}$/)
      expect(sell.kind).toBe('SELL')
      expect(exch.kind).toBe('EXCHANGE')
    })

    it('refuses to create the wrong kind in each section', async () => {
      await expect(svc.createRequest(admin(), exchangeInput())).rejects.toMatchObject({ code: 'WRONG_SECTION' })
      await expect(svc.createRequest(adminX(), input())).rejects.toMatchObject({ code: 'WRONG_SECTION' })
      await expect(svc.createRequest(custX(), input({ type: 'BUY_NOW' }))).rejects.toMatchObject({ code: 'WRONG_SECTION' })
    })

    it('never shows one section’s rows in the other (list, count, get, stats)', async () => {
      const sellList = (await svc.listManage(admin(), { limit: 100 })).data
      const exList = (await svc.listManage(adminX(), { limit: 100 })).data
      expect(sellList.items.every((i) => i.kind === 'SELL' && i.type !== 'EXCHANGE')).toBe(true)
      expect(exList.items.every((i) => i.kind === 'EXCHANGE' && i.type === 'EXCHANGE')).toBe(true)
      expect(sellList.items.map((i) => i.id)).not.toContain(exch.id)
      expect(exList.items.map((i) => i.id)).not.toContain(sell.id)
      const dbSell = (await q(`SELECT COUNT(*)::int n FROM sell_requests WHERE kind='SELL'`)).rows[0].n
      const dbEx = (await q(`SELECT COUNT(*)::int n FROM sell_requests WHERE kind='EXCHANGE'`)).rows[0].n
      expect(sellList.total).toBe(dbSell)
      expect(exList.total).toBe(dbEx)
      // searching by the other section's code or IMEI finds nothing
      expect((await svc.listManage(admin(), { q: exch.code })).data.total).toBe(0)
      expect((await svc.listManage(adminX(), { q: sell.device.imei })).data.total).toBe(0)

      await expect(svc.getManage(admin(), exch.id)).rejects.toMatchObject({ statusCode: 404 })
      await expect(svc.getManage(adminX(), sell.id)).rejects.toMatchObject({ statusCode: 404 })

      const sStats = await svc.stats(admin())
      const xStats = await svc.stats(adminX())
      expect(sStats.total).toBe(dbSell)
      expect(xStats.total).toBe(dbEx)
      expect(xStats.awaitingOrder).toBeGreaterThanOrEqual(1)
      expect(sStats.awaitingOrder).toBeUndefined()
    })

    it('every action is blocked across sections', async () => {
      for (const fn of [
        () => svc.approve(adminX(), sell.id),
        () => svc.reject(adminX(), sell.id, 'x'),
        () => svc.cancel(adminX(), sell.id),
        () => svc.requestInfo(adminX(), sell.id, 'x'),
        () => svc.assignVendor(adminX(), sell.id, F.vendorA),
        () => svc.complete(adminX(), sell.id),
        () => svc.placeOffer(vendorAX(), sell.id, { amount: 1000 }),
        () => svc.approve(admin(), exch.id),
        () => svc.reject(admin(), exch.id, 'x'),
        () => svc.cancel(admin(), exch.id),
        () => svc.placeOffer(vendorA(), exch.id, { amount: 1000 }),
        () => svc.linkOrder(admin(), exch.id, 'x'),
      ]) await expect(fn()).rejects.toMatchObject({ statusCode: 404 })
      // …and nothing changed
      expect((await svc.getManage(admin(), sell.id)).status).toBe('PENDING')
      expect((await svc.getManage(adminX(), exch.id)).status).toBe('PENDING')
    })

    it('a vendor sees open requests only in the section they query', async () => {
      const sv = (await svc.listManage(vendorA(), { limit: 100 })).data.items
      const xv = (await svc.listManage(vendorAX(), { limit: 100 })).data.items
      expect(sv.some((i) => i.id === sell.id)).toBe(true)
      expect(sv.some((i) => i.id === exch.id)).toBe(false)
      expect(xv.some((i) => i.id === exch.id)).toBe(true)
      expect(xv.some((i) => i.id === sell.id)).toBe(false)
    })

    it('a customer’s history is separate per section', async () => {
      const s2 = await svc.createRequest(custS(), input())
      const x2 = await svc.createRequest(custX(), exchangeInput())
      const mineS = (await svc.mine(F.cust, 'SELL')).data.items.map((i) => i.id)
      const mineX = (await svc.mine(F.cust, 'EXCHANGE')).data.items.map((i) => i.id)
      expect(mineS).toContain(s2.id); expect(mineS).not.toContain(x2.id)
      expect(mineX).toContain(x2.id); expect(mineX).not.toContain(s2.id)
      await expect(svc.getMine(F.cust, x2.id, 'SELL')).rejects.toMatchObject({ statusCode: 404 })
      await expect(svc.getMine(F.cust, s2.id, 'EXCHANGE')).rejects.toMatchObject({ statusCode: 404 })
      await expect(svc.cancel(custS(), x2.id)).rejects.toMatchObject({ statusCode: 404 })
    })

    it('an exchange can carry its order from the start (customer bought the new phone first)', async () => {
      const o = await mkOrder2(F.cust)
      const x = await svc.createRequest(custX(), exchangeInput({ orderNumber: o.num }))
      expect(x.exchangeOrder.orderNumber).toBe(o.num)
      expect(x.timeline.some((t) => t.label.includes(o.num))).toBe(true)
      // someone else's order, or a reused one, is refused and nothing is created
      const before = (await q(`SELECT COUNT(*)::int n FROM sell_requests`)).rows[0].n
      await expect(svc.createRequest(custX(), exchangeInput({ orderNumber: (await mkOrder2(await mkUser('Stranger'))).num }))).rejects.toMatchObject({ code: 'ORDER_MISMATCH' })
      await expect(svc.createRequest(custX(), exchangeInput({ orderNumber: o.num }))).rejects.toMatchObject({ code: 'ORDER_ALREADY_LINKED' })
      expect((await q(`SELECT COUNT(*)::int n FROM sell_requests`)).rows[0].n).toBe(before)
    })
  })
})
