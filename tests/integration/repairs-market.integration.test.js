/**
 * Repair marketplace — customer posts a repair, nearby vendors quote, customer compares, selects, tracks, rates.
 * Real app over HTTP, real Postgres.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=repair_market_test DB_USER=dealker_user \
 *   DB_PASSWORD=dealker_password_dev REDIS_HOST=localhost REDIS_PORT=6380 \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… \
 *   npx vitest run tests/integration/repairs-market.integration.test.js
 * The database must be fully migrated (npm run db:migrate). Do not set LOG_LEVEL=silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip
const C = '/api/v1/repairs'
const M = '/api/v1/manage/repairs'
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString()

d('repair marketplace', () => {
  let app, q, tmp
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const imei = () => `MK${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase()
  const call = async (method, url, who, payload) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${who.token}` }, payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data }
  }
  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkVendor = async (key, { lat, lng, pincode = '700001', price = null, brand = 'Apple' } = {}) => {
    const n = rand()
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Shop ${key} ${n}`, `mk-${n}`, `m${n}@x.test`, `7${n}`])
    T[key] = await mkToken('CUSTOMER', `Owner ${key}`)
    T[key].vendorId = v.rows[0].id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T[key].vendorId, T[key].id])
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, is_active)
             VALUES ($1,$2,$3,'1 Main Rd','Kolkata','WB',$4,$5,$6,$7,TRUE)`, [`Shop ${key}`, `s-${n}`, `B${n.slice(0, 8)}`, pincode, lat, lng, T[key].vendorId])
    if (price) {
      const r = await call('POST', `${M}/market/services/bulk`, T[key], {
        deviceCategory: 'Smartphone', brand, model: 'iPhone 14 Pro', services: [
          { problemCategory: 'SCREEN', partsPrice: price.screenParts, labourPrice: price.screenLabour, estDaysMin: 1, estDaysMax: 2, warrantyDays: 90 },
          { problemCategory: 'BATTERY', partsPrice: price.batParts, labourPrice: 300, estDaysMin: 1, estDaysMax: 1, warrantyDays: 60 },
        ],
      })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    }
  }
  const body = (extra = {}) => ({
    channel: 'B2C', description: 'Display not working',
    items: [{ brand: 'Apple', model: 'iPhone 14 Pro', imeiSerial: imei(), problemCategories: ['SCREEN'], problemDescription: 'Display not working, touch not responding', warrantyStatus: 'OUT_OF_WARRANTY' }],
    location: { lat: 22.5726, lng: 88.3639, pincode: '700001' }, ...extra,
  })

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-market-'))
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000', PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'), REPAIR_NO_NOTIFY: '1' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await q(`UPDATE repair_settings SET enabled = TRUE, b2c_enabled = TRUE, marketplace_enabled = TRUE, auto_quote_enabled = TRUE, search_radius_km = 15, offer_window_hours = 24,
             max_offers = 12, require_advance = TRUE, advance_pct = 30, tax_pct = 18, platform_commission_pct = 10, default_warranty_days = 90 WHERE id = TRUE`)
    // earlier runs leave vendors behind; park them so only this run's shops are in range
    await q(`UPDATE vendors SET is_active = FALSE WHERE slug LIKE 'mk-%'`)
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Rahul Sharma')
    T.other = await mkToken('CUSTOMER', 'Someone Else')
    // A ≈ 1 km, B ≈ 5 km (both near); C is ~600 km away; D is near but sells nothing the customer needs.
    await mkVendor('vendA', { lat: 22.5800, lng: 88.3700, price: { screenParts: 3200, screenLabour: 800, batParts: 1500 } })
    await mkVendor('vendB', { lat: 22.6200, lng: 88.3900, price: { screenParts: 2500, screenLabour: 600, batParts: 1200 } })
    await mkVendor('vendC', { lat: 28.6139, lng: 77.2090, pincode: '110001', price: { screenParts: 1000, screenLabour: 100, batParts: 900 } })
    await mkVendor('vendD', { lat: 22.5700, lng: 88.3600 })
  }, 90000)
  afterAll(async () => { await app?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  let id, offers, itemId

  describe('request → nearby offers', () => {
    it('creating a request generates live quotes only from in-range vendors that price every issue', async () => {
      const created = await call('POST', C, T.cust, body())
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      id = created.data.id
      expect(created.data).toMatchObject({ flow: 'MARKETPLACE', status: 'REQUESTED', offerCount: 2 })
      itemId = created.data.items[0].id
      expect(created.data.items[0].problemCategories).toEqual(['SCREEN'])
      const res = await call('GET', `${C}/${id}/offers`, T.cust)
      expect(res.status).toBe(200)
      offers = res.data.offers
      expect(offers.map((o) => o.vendorId).sort()).toEqual([T.vendA.vendorId, T.vendB.vendorId].sort())
      const a = offers.find((o) => o.vendorId === T.vendA.vendorId)
      expect(a).toMatchObject({ live: true, status: 'OPEN', subtotal: 4000, taxAmount: 720, total: 4720, estDaysMin: 1, estDaysMax: 2, warrantyDays: 90 })
      expect(a.distanceKm).toBeGreaterThan(0)
      expect(a.distanceKm).toBeLessThan(3)
      expect(a.lines.map((l) => l.kind).sort()).toEqual(['LABOUR', 'PART'])
      const b = offers.find((o) => o.vendorId === T.vendB.vendorId)
      expect(b.total).toBe(3658)   // (2500 + 600) × 1.18
    })

    it('sorts by lowest price / nearest and flags the best deal', async () => {
      const low = (await call('GET', `${C}/${id}/offers?sort=lowest_price`, T.cust)).data
      expect(low.offers[0].vendorId).toBe(T.vendB.vendorId)
      expect(low.lowestTotal).toBe(3658)
      expect(low.offers[0].badges).toContain('LOWEST_PRICE')
      const near = (await call('GET', `${C}/${id}/offers?sort=nearest`, T.cust)).data
      expect(near.offers[0].vendorId).toBe(T.vendA.vendorId)
      expect((await call('GET', `${C}/${id}/offers?sort=bogus`, T.cust)).status).toBe(422)
    })

    it('other customers cannot see the offers', async () => {
      expect((await call('GET', `${C}/${id}/offers`, T.other)).status).toBe(404)
    })

    it('a vendor sees nearby requests anonymised; an out-of-range vendor sees nothing', async () => {
      const a = await call('GET', `${M}/market/incoming`, T.vendA)
      expect(a.status).toBe(200)
      const row = a.data.items.concat((await call('GET', `${M}/market/incoming?tab=quoted`, T.vendA)).data.items).find((x) => x.id === id)
      expect(row).toBeTruthy()
      expect(row.customer).toMatchObject({ firstName: 'Rahul', pincode: '700001' })
      expect(JSON.stringify(row)).not.toMatch(/"phone"|address|Sharma/)
      const c = await call('GET', `${M}/market/incoming?tab=all`, T.vendC)
      expect(c.data.items.map((x) => x.id)).not.toContain(id)
      expect((await call('GET', `${M}/market/incoming/${id}`, T.vendC)).status).toBe(404)
    })

    it('a nearby vendor with no price list can still quote by hand; an out-of-range vendor cannot', async () => {
      const lines = [{ kind: 'PART', description: 'OEM display', unitPrice: 2000 }, { kind: 'LABOUR', description: 'Fitting', unitPrice: 500 }]
      const far = await call('POST', `${M}/market/incoming/${id}/offer`, T.vendC, { lines })
      expect(far.status).toBe(403)
      expect(far.body.code).toBe('OUT_OF_RANGE')
      const ok = await call('POST', `${M}/market/incoming/${id}/offer`, T.vendD, { lines, estDaysMin: 1, estDaysMax: 3, warrantyDays: 180, note: 'Original display' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      expect(ok.data).toMatchObject({ live: false, total: 2950, warrantyDays: 180 })
      const list = (await call('GET', `${C}/${id}/offers?sort=lowest_price`, T.cust)).data
      expect(list.count).toBe(3)
      expect(list.offers[0].vendorId).toBe(T.vendD.vendorId)
    })

    it('a hand-written quote line remembers which repair it is for, and refuses unknown repair types', async () => {
      const r = await call('POST', C, T.cust, body())
      const lines = [{ kind: 'PART', description: 'Display', unitPrice: 2000, problemCategory: 'SCREEN' }]
      const ok = await call('POST', `${M}/market/incoming/${r.data.id}/offer`, T.vendD, { lines })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      expect(ok.data.lines[0].problemCategory).toBe('SCREEN')
      const bad = await call('POST', `${M}/market/incoming/${r.data.id}/offer`, T.vendD, { lines: [{ ...lines[0], problemCategory: 'NOPE' }] })
      expect(bad.status).toBe(422)
    })

    it('rejects bad quotes: client totals are ignored, bad prices and foreign items are refused', async () => {
      const bad = await call('POST', `${M}/market/incoming/${id}/offer`, T.vendD, { lines: [{ kind: 'PART', description: 'x', unitPrice: -5 }] })
      expect(bad.status).toBe(422)
      const foreign = await call('POST', `${M}/market/incoming/${id}/offer`, T.vendD, { lines: [{ kind: 'PART', description: 'Part', unitPrice: 10, itemId: crypto.randomUUID() }] })
      expect(foreign.status).toBe(422)
      const ignored = await call('POST', `${M}/market/incoming/${id}/offer`, T.vendD, { total: 1, lines: [{ kind: 'PART', description: 'OEM display', unitPrice: 2000 }, { kind: 'LABOUR', description: 'Fitting', unitPrice: 500 }] })
      expect(ignored.data.total).toBe(2950)
    })

    it('a vendor can withdraw its quote', async () => {
      const w = await call('DELETE', `${M}/market/incoming/${id}/offer`, T.vendD)
      expect(w.status).toBe(200)
      expect(w.data.status).toBe('WITHDRAWN')
      expect((await call('GET', `${C}/${id}/offers`, T.cust)).data.count).toBe(2)
    })
  })

  describe('select an offer → pickup & delivery → repair → rate', () => {
    it('rejects missing fulfilment details and a vendor choosing for the customer', async () => {
      const offer = offers.find((o) => o.vendorId === T.vendB.vendorId)
      expect((await call('POST', `${C}/${id}/offers/${offer.id}/select`, T.cust, {})).status).toBe(422)
      expect((await call('POST', `${C}/${id}/offers/${offer.id}/select`, T.cust, { fulfilment: 'PICKUP_DELIVERY', pickupAddress: 'short' })).status).toBe(422)
      expect((await call('POST', `${C}/${id}/offers/${offer.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT' })).status).toBe(422)   // needs a time
      expect((await call('POST', `${C}/${id}/offers/${offer.id}/select`, T.other, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })).status).toBe(404)
      expect((await call('POST', `${C}/${id}/offers/${offer.id}/select`, T.vendB, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })).status).toBe(404)
    })

    it('selecting an offer assigns that vendor and closes the others — only once, even in parallel', async () => {
      const a = offers.find((o) => o.vendorId === T.vendA.vendorId)
      const b = offers.find((o) => o.vendorId === T.vendB.vendorId)
      const pick = (o) => call('POST', `${C}/${id}/offers/${o.id}/select`, T.cust, { fulfilment: 'PICKUP_DELIVERY', pickupAddress: 'A-101, Green Valley Apt, Sector 45, Noida, 201301', pickupSlot: tomorrow() })
      const [r1, r2] = await Promise.all([pick(a), pick(b)])
      expect([r1.status, r2.status].sort()).toEqual([200, 409])
      const won = r1.status === 200 ? { r: r1, o: a } : { r: r2, o: b }
      expect(won.r.data).toMatchObject({ status: 'ACCEPTED', fulfilment: 'PICKUP_DELIVERY', serviceMode: 'PICKUP', serviceCenterId: won.o.vendorId, selectedOfferId: won.o.id })
      const { rows } = await q(`SELECT status, COUNT(*)::int AS n FROM repair_offers WHERE request_id = $1 GROUP BY status ORDER BY status`, [id])
      expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toMatchObject({ SELECTED: 1, NOT_SELECTED: 1 })
      T.winner = won.o.vendorId === T.vendA.vendorId ? T.vendA : T.vendB
      T.winnerOffer = won.o
      expect((await call('POST', `${C}/${id}/offers/${(won.o === a ? b : a).id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })).status).toBe(409)
    })

    it('the vendor now sees the full request; the losing vendor does not', async () => {
      const loser = T.winner === T.vendA ? T.vendB : T.vendA
      const seen = await call('GET', `${M}/${id}`, T.winner)
      expect(seen.status).toBe(200)
      expect(seen.data.customer.phone).toBeTruthy()
      expect(seen.data.pickupAddress).toContain('Green Valley')
      expect((await call('GET', `${M}/${id}`, loser)).status).toBe(404)
    })

    it('tracking starts at "Request Accepted" with the pickup scheduled', async () => {
      const t = (await call('GET', `${C}/${id}/tracking`, T.cust)).data
      expect(t.steps.map((s) => s.label)).toEqual(['Request Accepted', 'Pickup Scheduled', 'Device Picked Up', 'At Repair Shop', 'Repair in Progress', 'Quality Check', 'Out for Delivery', 'Delivered'])
      expect(t.steps.filter((s) => s.done).map((s) => s.label)).toEqual(['Request Accepted', 'Pickup Scheduled'])
      expect(t.steps.find((s) => s.current).label).toBe('Device Picked Up')
      expect(t.serviceCenter.name).toMatch(/^Shop/)
    })

    it('the device cannot reach the shop before it is picked up; steps follow the real lifecycle', async () => {
      const w = T.winner
      expect((await call('POST', `${M}/${id}/receive`, w)).status).toBe(409)
      expect((await call('POST', `${M}/${id}/confirm-price`, w)).status).toBe(409)
      expect((await call('POST', `${M}/${id}/picked-up`, T.other)).status).toBe(403)   // not a service centre
      expect((await call('POST', `${M}/${id}/picked-up`, T.cust)).status).toBe(403)
      expect((await call('POST', `${M}/${id}/picked-up`, w, { note: 'collected by Ravi' })).status).toBe(200)
      expect((await call('POST', `${M}/${id}/picked-up`, w)).status).toBe(409)   // once
      expect((await call('POST', `${M}/${id}/receive`, w)).data.status).toBe('INSPECTION')
    })

    it('confirming the agreed price approves the estimate at exactly the offer total', async () => {
      const w = T.winner
      const done = await call('POST', `${M}/${id}/confirm-price`, w)
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      expect(done.data.status).toBe('ESTIMATE_APPROVED')
      expect(done.data.money.approvedTotal).toBe(T.winnerOffer.total)
      expect(done.data.money.advanceRequired).toBe(Math.round(T.winnerOffer.total * 30) / 100)
      expect((await call('POST', `${M}/${id}/start`, w)).body.code).toBe('ADVANCE_REQUIRED')
    })

    it('the service centre collects the advance, but cannot refund', async () => {
      const w = T.winner
      const cur = (await call('GET', `${M}/${id}`, w)).data
      const adv = cur.money.advanceRequired
      const pay = (b) => call('POST', `${M}/${id}/payments`, w, { method: 'UPI', idempotencyKey: crypto.randomUUID(), ...b })
      expect((await pay({ kind: 'ADVANCE', amount: adv })).status).toBe(200)
      expect((await pay({ kind: 'REFUND', amount: 1, note: 'x' })).status).toBe(403)
      expect((await call('POST', `${C}/${id}/offers/${T.winnerOffer.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })).status).toBe(409)   // already chosen
    })

    it('repair → QC → ready; delivery needs "out for delivery" and the balance', async () => {
      const w = T.winner
      expect((await call('POST', `${M}/${id}/start`, w)).data.status).toBe('IN_REPAIR')
      expect((await call('POST', `${M}/${id}/send-to-qc`, w)).data.status).toBe('QC_PENDING')
      expect((await call('POST', `${M}/${id}/qc`, w, { results: [{ itemId, passed: true }] })).data.status).toBe('REPAIRED')
      expect((await call('POST', `${M}/${id}/ready`, w)).data.status).toBe('READY_FOR_DELIVERY')
      expect((await call('POST', `${M}/${id}/deliver`, w)).status).toBe(409)   // not out for delivery
      expect((await call('POST', `${M}/${id}/out-for-delivery`, w, { trackingUrl: 'javascript:alert(1)' })).status).toBe(422)
      const out = await call('POST', `${M}/${id}/out-for-delivery`, w, { courier: 'Porter', trackingUrl: 'https://track.example.com/abc' })
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      const due = await call('POST', `${M}/${id}/deliver`, w)
      expect(due.body.code).toBe('PAYMENT_DUE')
      const cur = (await call('GET', `${M}/${id}`, w)).data
      expect((await call('POST', `${M}/${id}/payments`, w, { kind: 'BALANCE', method: 'CASH', amount: cur.money.amountDue, idempotencyKey: crypto.randomUUID() })).status).toBe(200)
      const fin = await call('POST', `${M}/${id}/deliver`, w)
      expect(fin.status, JSON.stringify(fin.body)).toBe(200)
      expect(fin.data.status).toBe('COMPLETED')
      expect(fin.data.warrantyUntil).toBeTruthy()
    })

    it('tracking is complete, with the courier link and no live location', async () => {
      const t = (await call('GET', `${C}/${id}/tracking`, T.cust)).data
      expect(t.steps.every((s) => s.done)).toBe(true)
      expect(t.steps.find((s) => s.key === 'OUT_FOR_DELIVERY').meta).toMatchObject({ courier: 'Porter', trackingUrl: 'https://track.example.com/abc' })
      expect(JSON.stringify(t)).not.toMatch(/"lat"|"lng"|rider/i)
    })

    it('the customer rates the repair once; the rating shows on the vendor in later offers', async () => {
      expect((await call('POST', `${C}/${id}/rate`, T.other, { stars: 5 })).status).toBe(404)
      expect((await call('POST', `${C}/${id}/rate`, T.cust, { stars: 9 })).status).toBe(422)
      const r = await call('POST', `${C}/${id}/rate`, T.cust, { stars: 4, review: 'Quick and clean' })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.data.rating).toMatchObject({ stars: 4, review: 'Quick and clean' })
      expect((await call('POST', `${C}/${id}/rate`, T.cust, { stars: 5 })).body.code).toBe('ALREADY_RATED')

      const next = await call('POST', C, T.other, body())
      expect(next.status, JSON.stringify(next.body)).toBe(201)
      const list = (await call('GET', `${C}/${next.data.id}/offers`, T.other)).data.offers
      const mine = list.find((o) => o.vendorId === T.winner.vendorId)
      expect(mine.vendor).toMatchObject({ rating: 4, ratingCount: 1, completedRepairs: 1 })
    })
  })

  describe('shop appointment path', () => {
    let rid, offerId
    it('select "book shop appointment" with a time; no pickup steps', async () => {
      const created = await call('POST', C, T.cust, body())
      rid = created.data.id
      offerId = (await call('GET', `${C}/${rid}/offers`, T.cust)).data.offers[0].id
      const sel = await call('POST', `${C}/${rid}/offers/${offerId}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      expect(sel.status, JSON.stringify(sel.body)).toBe(200)
      expect(sel.data).toMatchObject({ status: 'ACCEPTED', fulfilment: 'SHOP_VISIT', serviceMode: 'DROP_OFF' })
      const t = (await call('GET', `${C}/${rid}/tracking`, T.cust)).data
      expect(t.steps.map((s) => s.label)).toEqual(['Request Accepted', 'Appointment Booked', 'Device Received at Shop', 'Repair in Progress', 'Quality Check', 'Ready for Pickup', 'Collected'])
      expect(t.steps.filter((s) => s.done)).toHaveLength(2)
    })
    it('pickup actions are refused; the shop receives the device directly', async () => {
      const w = T.vendA.vendorId === (await q('SELECT assigned_vendor_id FROM repair_requests WHERE id = $1', [rid])).rows[0].assigned_vendor_id ? T.vendA : T.vendB
      expect((await call('POST', `${M}/${rid}/picked-up`, w)).status).toBe(409)
      expect((await call('POST', `${M}/${rid}/receive`, w)).data.status).toBe('INSPECTION')
    })
    it('the customer can cancel before the device arrives, and an expired offer cannot be chosen', async () => {
      const created = await call('POST', C, T.cust, body())
      const x = created.data.id
      const o = (await call('GET', `${C}/${x}/offers`, T.cust)).data.offers[0]
      await q(`UPDATE repair_offers SET valid_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [o.id])
      const expired = await call('POST', `${C}/${x}/offers/${o.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      expect(expired.body.code).toBe('OFFER_EXPIRED')
      expect((await call('GET', `${C}/${x}/offers`, T.cust)).data.offers.map((y) => y.id)).not.toContain(o.id)
      expect((await call('POST', `${C}/${x}/cancel`, T.cust, { reason: 'changed my mind' })).data.status).toBe('CANCELLED')
    })
  })

  describe('price list', () => {
    it('a vendor manages only its own list; admin can manage any', async () => {
      const mine = (await call('GET', `${M}/market/services`, T.vendA)).data
      expect(mine.length).toBe(2)
      expect(mine.every((s) => s.vendorId === T.vendA.vendorId)).toBe(true)
      const sid = mine[0].id
      expect((await call('PUT', `${M}/market/services/${sid}`, T.vendB, { partsPrice: 1 })).status).toBe(404)
      expect((await call('DELETE', `${M}/market/services/${sid}`, T.vendB)).status).toBe(404)
      const upd = await call('PUT', `${M}/market/services/${sid}`, T.vendA, { partsPrice: 3300 })
      expect(upd.data.partsPrice).toBe(3300)
      await call('PUT', `${M}/market/services/${sid}`, T.vendA, { partsPrice: mine[0].partsPrice })
      const adminAdd = await call('POST', `${M}/market/services`, T.admin, { vendorId: T.vendD.vendorId, brand: 'Samsung', model: 'S23 Ultra', problemCategory: 'CAMERA', partsPrice: 4000, labourPrice: 500 })
      expect(adminAdd.status, JSON.stringify(adminAdd.body)).toBe(201)
      expect((await call('POST', `${M}/market/services`, T.admin, { brand: 'Samsung', problemCategory: 'CAMERA', partsPrice: 1 })).status).toBe(422)   // admin must name a vendor
      expect((await call('POST', `${M}/market/services`, T.vendA, { brand: 'Apple', model: 'X', problemCategory: 'SCREEN', partsPrice: 0, labourPrice: 0 })).status).toBe(422)
      // the same brand/model/issue updates in place rather than duplicating
      await call('POST', `${M}/market/services/bulk`, T.vendA, { brand: 'apple', model: 'iphone 14 pro', services: [{ problemCategory: 'SCREEN', partsPrice: 3200, labourPrice: 800 }] })
      expect((await call('GET', `${M}/market/services`, T.vendA)).data.length).toBe(2)
    })

    it('customers cannot reach the vendor APIs', async () => {
      expect((await call('GET', `${M}/market/services`, T.cust)).status).toBe(403)
      expect((await call('GET', `${M}/market/incoming`, T.cust)).status).toBe(403)
    })
  })

  describe('booking form helpers', () => {
    it('config lists issues and device types; catalogue returns brands', async () => {
      const cfg = (await call('GET', `${C}/config`, T.cust)).data
      expect(cfg.issues.map((i) => i.key)).toEqual(expect.arrayContaining(['SCREEN', 'BATTERY', 'TOUCH', 'CHARGING']))
      expect(cfg.settings.marketplaceEnabled).toBe(true)
      const brands = (await call('GET', `${C}/catalogue/brands`, T.cust)).data
      expect(brands.map((b) => b.name)).toContain('Apple')
      expect((await call('GET', `${C}/catalogue/models`, T.cust)).status).toBe(422)
      expect((await call('GET', `${C}/devices/recent`, T.cust)).data[0]).toMatchObject({ brand: 'Apple', model: 'iPhone 14 Pro' })
    })
    it('a marketplace request needs a location', async () => {
      const b = body({ marketplace: true }); delete b.location
      expect((await call('POST', C, T.cust, b)).status).toBe(422)
      b.marketplace = undefined
      expect((await call('POST', C, T.cust, b)).data.flow).toBe('DIRECT')   // no location → admin-assigned flow
    })
    it('several issues on one device must all be priced by the vendor to get a live quote', async () => {
      const r = await call('POST', C, T.cust, body({ items: [{ brand: 'Apple', model: 'iPhone 14 Pro', problemCategories: ['SCREEN', 'BATTERY'], warrantyStatus: 'UNKNOWN' }] }))
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      const list = (await call('GET', `${C}/${r.data.id}/offers`, T.cust)).data.offers
      const a = list.find((o) => o.vendorId === T.vendA.vendorId)
      expect(a.subtotal).toBe(3200 + 800 + 1500 + 300)
      const tooMany = await call('POST', C, T.cust, body({ items: [{ brand: 'Apple', model: 'iPhone 14 Pro', problemCategories: ['SCREEN', 'CAMERA'] }] }))
      expect((await call('GET', `${C}/${tooMany.data.id}/offers`, T.cust)).data.count).toBe(0)   // nobody prices camera repair
    })
  })
  describe('vendor app support', () => {
    let rid
    it('the "accepting requests" switch hides a shop from new requests without touching its price list', async () => {
      expect((await call('GET', `${M}/market/profile`, T.vendA)).data).toMatchObject({ acceptingRequests: true, activeServices: 2 })
      const off = await call('PUT', `${M}/market/profile`, T.vendA, { acceptingRequests: false })
      expect(off.data.acceptingRequests).toBe(false)
      expect((await call('PUT', `${M}/market/profile`, T.vendA, { acceptingRequests: 'no' })).status).toBe(422)
      const r = await call('POST', C, T.cust, body({ items: [{ brand: 'Apple', model: 'iPhone 14 Pro', color: 'Space Black', problemCategories: ['SCREEN'] }] }))
      rid = r.data.id
      expect(r.data.items[0].color).toBe('Space Black')
      const offers = (await call('GET', `${C}/${rid}/offers`, T.cust)).data.offers
      expect(offers.map((o) => o.vendorId)).not.toContain(T.vendA.vendorId)
      expect((await call('GET', `${M}/market/incoming?tab=all`, T.vendA)).data.items.map((x) => x.id)).not.toContain(rid)
      await call('PUT', `${M}/market/profile`, T.vendA, { acceptingRequests: true })
      expect((await call('GET', `${M}/market/incoming?tab=all`, T.vendA)).data.items.map((x) => x.id)).toContain(rid)
    })

    it('request details include IMEI, colour and the customer\'s history; counts cover accepted and completed', async () => {
      const d = (await call('GET', `${M}/market/incoming/${rid}`, T.vendA)).data
      expect(d.items[0]).toMatchObject({ color: 'Space Black', model: 'iPhone 14 Pro' })
      expect(d.customer.completedRepairs).toBeGreaterThanOrEqual(1)
      const inc = (await call('GET', `${M}/market/incoming`, T.vendA)).data
      expect(inc.counts).toEqual(expect.objectContaining({ new: expect.any(Number), quoted: expect.any(Number), accepted: expect.any(Number), completed: expect.any(Number) }))
      expect(inc.counts.completed).toBeGreaterThanOrEqual(0)
    })

    it('suggests quote lines from the vendor price list and reports what it cannot price', async () => {
      const r = await call('POST', C, T.cust, body({ items: [{ brand: 'Apple', model: 'iPhone 14 Pro', problemCategories: ['SCREEN', 'CAMERA'] }] }))
      const sg = await call('GET', `${M}/market/incoming/${r.data.id}/suggested-quote`, T.vendA)
      expect(sg.status, JSON.stringify(sg.body)).toBe(200)
      expect(sg.data.lines).toHaveLength(2)
      expect(sg.data.lines.every((l) => l.problemCategory === 'SCREEN')).toBe(true)
      expect(sg.data.missing).toEqual([expect.objectContaining({ problemCategory: 'CAMERA' })])
      expect(sg.data.totals.total).toBe(4720)
      expect((await call('GET', `${M}/market/incoming/${r.data.id}/suggested-quote`, T.vendC)).status).toBe(404)
    })

    it('the assigned service centre sees the agreed offer price before confirming it; the customer view does not carry it', async () => {
      const r = await call('POST', C, T.cust, body())
      const x = r.data.id
      const offer = (await call('GET', `${C}/${x}/offers?sort=nearest`, T.cust)).data.offers[0]
      await call('POST', `${C}/${x}/offers/${offer.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      const w = offer.vendorId === T.vendA.vendorId ? T.vendA : T.vendB
      const job = (await call('GET', `${M}/${x}`, w)).data
      expect(job.status).toBe('ACCEPTED')
      expect(job.selectedOffer).toMatchObject({ total: offer.total, warrantyDays: expect.any(Number) })
      expect(job.selectedOffer.lines.length).toBeGreaterThan(0)
      expect((await call('GET', `${C}/${x}`, T.cust)).data.selectedOffer).toBeUndefined()
    })

    it('the vendor posts repair updates (visible in the timeline) and lists active / completed orders by tab', async () => {
      const r = await call('POST', C, T.cust, body())
      const x = r.data.id
      const offer = (await call('GET', `${C}/${x}/offers?sort=nearest`, T.cust)).data.offers[0]
      await call('POST', `${C}/${x}/offers/${offer.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      const w = offer.vendorId === T.vendA.vendorId ? T.vendA : T.vendB
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'RECEIVED', note: 'Device received' })).data.timeline.at(-1).label).toMatch(/Received/)
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'BOGUS', note: 'x' })).status).toBe(422)
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'TESTING' })).status).toBe(422)   // needs a note or photos
      expect((await call('POST', `${M}/${x}/update`, T.cust, { stage: 'TESTING', note: 'x' })).status).toBe(403)
      const active = (await call('GET', `${M}?tab=active`, w)).data
      expect(active.items.map((i) => i.id)).toContain(x)
      expect((await call('GET', `${M}?tab=completed`, w)).data.items.map((i) => i.id)).not.toContain(x)
    })

    it('a vendor can reject a request (Rejected tab), reconsider it, and quoting clears the rejection', async () => {
      const r = await call('POST', C, T.cust, body())
      const x = r.data.id
      const ids = async (tab, w) => (await call('GET', `${M}/market/incoming?tab=${tab}`, w)).data
      expect((await ids('all', T.vendD)).items.map((i) => i.id)).toContain(x)
      expect((await call('POST', `${M}/market/incoming/${x}/decline`, T.cust, {})).status).toBe(403)
      expect((await call('POST', `${M}/market/incoming/${x}/decline`, T.vendC, {})).status).toBe(404)   // out of range
      const rej = await call('POST', `${M}/market/incoming/${x}/decline`, T.vendD, { reason: 'Too busy' })
      expect(rej.status, JSON.stringify(rej.body)).toBe(200)
      const all = await ids('all', T.vendD)
      expect(all.items.map((i) => i.id)).not.toContain(x)
      const rejected = await ids('rejected', T.vendD)
      expect(rejected.items.map((i) => i.id)).toContain(x)
      expect(rejected.counts.rejected).toBe(rejected.items.length)
      // other vendors are unaffected
      expect((await ids('all', T.vendA)).items.map((i) => i.id)).toContain(x)
      expect((await call('DELETE', `${M}/market/incoming/${x}/decline`, T.vendD)).status).toBe(200)
      expect((await ids('all', T.vendD)).items.map((i) => i.id)).toContain(x)
      // rejecting after quoting withdraws the quote; quoting again clears the rejection
      const lines = [{ kind: 'PART', description: 'Display', unitPrice: 2000 }]
      expect((await call('POST', `${M}/market/incoming/${x}/offer`, T.vendD, { lines })).status).toBe(201)
      expect((await call('POST', `${M}/market/incoming/${x}/decline`, T.vendD, {})).status).toBe(200)
      expect((await call('GET', `${C}/${x}/offers`, T.cust)).data.offers.map((o) => o.vendorId)).not.toContain(T.vendD.vendorId)
      expect((await call('POST', `${M}/market/incoming/${x}/offer`, T.vendD, { lines })).status).toBe(201)
      expect((await ids('rejected', T.vendD)).items.map((i) => i.id)).not.toContain(x)
    })

    it('records device-check rows and per-issue progress with the part used; hidden updates stay off the customer timeline', async () => {
      const r = await call('POST', C, T.cust, body())
      const x = r.data.id
      const item = r.data.items[0].id
      const offer = (await call('GET', `${C}/${x}/offers?sort=nearest`, T.cust)).data.offers[0]
      await call('POST', `${C}/${x}/offers/${offer.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      const w = offer.vendorId === T.vendA.vendorId ? T.vendA : T.vendB
      const check = await call('POST', `${M}/${x}/update`, w, { stage: 'DIAGNOSING', note: 'Battery low', checks: [{ key: 'screen', label: 'Screen', result: 'ISSUE' }, { key: 'battery', result: 'LOW' }] })
      expect(check.status, JSON.stringify(check.body)).toBe(200)
      expect(check.data.timeline.at(-1).progress.checks).toEqual([{ key: 'SCREEN', label: 'Screen', result: 'ISSUE' }, { key: 'BATTERY', label: 'BATTERY', result: 'LOW' }])
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'DIAGNOSING', checks: [{ key: 'screen', result: 'GREAT' }] })).status).toBe(422)
      const done = await call('POST', `${M}/${x}/update`, w, { stage: 'REPAIR_IN_PROGRESS', issue: 'SCREEN', issueStatus: 'DONE', itemId: item, part: { name: 'OEM display', price: 3500, warrantyDays: 90 } })
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      const last = done.data.timeline.at(-1)
      expect(last.label).toMatch(/Display replacement completed/)
      expect(last.progress).toMatchObject({ issue: 'SCREEN', issueStatus: 'DONE', itemId: item, part: { name: 'OEM display', price: 3500, warrantyDays: 90 } })
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'OTHER', issueStatus: 'DONE' })).status).toBe(422)          // status needs an issue
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'OTHER', issue: 'NOPE', issueStatus: 'DONE' })).status).toBe(422)
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'OTHER', issue: 'SCREEN', issueStatus: 'DONE', itemId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422)
      expect((await call('POST', `${M}/${x}/update`, w, { stage: 'OTHER', issue: 'BATTERY', issueStatus: 'STARTED', part: { price: 5 } })).status).toBe(422)   // part needs a name
      await call('POST', `${M}/${x}/update`, w, { stage: 'TESTING', note: 'internal only', notify: false })
      const mine = (await call('GET', `${C}/${x}`, T.cust)).data.timeline.map((t) => t.label)
      expect(mine.some((l) => /internal only/.test(l))).toBe(false)
      expect(mine.some((l) => /Display replacement completed/.test(l))).toBe(true)
      expect((await call('GET', `${M}/${x}`, w)).data.timeline.some((t) => /internal only/.test(t.label))).toBe(true)
    })
  })
})
