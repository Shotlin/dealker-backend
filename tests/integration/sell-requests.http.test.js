/**
 * Sell requests — HTTP layer (routing, auth, permission + vendor-scope guards) against the real app.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5440 DB_NAME=sell_test DB_USER=t DB_PASSWORD=t \
 *   REDIS_PORT=6441 npx vitest run tests/integration/sell-requests.http.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip

d('sell requests HTTP', () => {
  let app, q
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const auth = (t) => ({ authorization: `Bearer ${t}` })
  const qa = { ageMonths: 12, screenScratches: 'MINOR', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: false, chargerAvailable: true, batteryHealth: 88, powersOn: true }
  const uniq14 = () => String(35000000000000 + Math.floor(Math.random() * 9e12))
  const luhn = (body) => { for (let c = 0; c < 10; c++) { const s = body + c; let sum = 0; for (let i = 0; i < 15; i++) { let n = Number(s[14 - i]); if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n } if (sum % 10 === 0) return s } }

  const mkToken = async (role, name, extra = {}) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version, ...extra }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Cust One')
    T.other = await mkToken('CUSTOMER', 'Cust Two')
    const n = rand()
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('HTTP Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, [`h-${n}`, `h${n}@x.test`, `7${n}`])
    T.vendorId = v.rows[0].id
    T.vend = await mkToken('CUSTOMER', 'Vendor User')
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T.vendorId, T.vend.id])
  }, 60000)
  afterAll(async () => { await app?.close() })

  it('requires authentication', async () => {
    for (const url of ['/api/v1/sell-requests/catalog', '/api/v1/manage/sell-requests', '/api/v1/manage/sell-requests/stats']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
  })

  it('customer: catalogue → quote → submit → track → cancel', async () => {
    const cat = (await app.inject({ method: 'GET', url: '/api/v1/sell-requests/catalog', headers: auth(T.cust.token) })).json()
    expect(cat.data.length).toBeGreaterThan(5)
    const body = { type: 'SELL_TO_AB', model: 'iPhone 13', variant: '256GB', color: 'Blue', imei: luhn(uniq14()), qa, description: 'ok', images: ['http://localhost:4500/uploads/2026-10/a.jpg'] }
    const qt = (await app.inject({ method: 'POST', url: '/api/v1/sell-requests/quote', headers: auth(T.cust.token), payload: body })).json()
    expect(qt.data.quote).toBeGreaterThan(0)

    const created = await app.inject({ method: 'POST', url: '/api/v1/sell-requests', headers: auth(T.cust.token), payload: body })
    expect(created.statusCode).toBe(201)
    const r = created.json().data
    expect(r.quote).toBe(qt.data.quote)
    T.reqId = r.id

    expect((await app.inject({ method: 'POST', url: '/api/v1/sell-requests', headers: auth(T.cust.token), payload: body })).statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: `/api/v1/sell-requests/${r.id}`, headers: auth(T.other.token) })).statusCode).toBe(404)
    const mine = (await app.inject({ method: 'GET', url: '/api/v1/sell-requests/mine', headers: auth(T.cust.token) })).json()
    expect(mine.data.items.map((i) => i.id)).toContain(r.id)

    const evil = await app.inject({ method: 'POST', url: '/api/v1/sell-requests', headers: auth(T.cust.token), payload: { ...body, imei: luhn(uniq14()), images: ['https://evil.example.com/x.jpg'] } })
    expect(evil.statusCode).toBe(422)

    const bad = await app.inject({ method: 'POST', url: '/api/v1/sell-requests', headers: auth(T.cust.token), payload: { ...body, imei: '1234' } })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().code).toBe('INVALID_IMEI')
  })

  it('customers cannot use the manage surface', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests', headers: auth(T.other.token) })
    expect([403]).toContain(res.statusCode)
  })

  it('vendor can list/view open requests, bid, but not approve/assign/settings', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests', headers: { ...auth(T.vend.token), 'x-vendor-id': T.vendorId } })
    expect(list.statusCode).toBe(200)
    expect(list.json().data.items.map((i) => i.id)).toContain(T.reqId)

    const offer = await app.inject({ method: 'POST', url: `/api/v1/manage/sell-requests/${T.reqId}/offers`, headers: { ...auth(T.vend.token), 'x-vendor-id': T.vendorId }, payload: { amount: 24000 } })
    expect(offer.statusCode).toBe(200)
    expect(offer.json().data.offers[0].amount).toBe(24000)

    for (const [method, path] of [['POST', 'approve'], ['POST', 'assign-vendor'], ['POST', 'reject'], ['GET', '../settings']]) {
      const res = await app.inject({ method, url: `/api/v1/manage/sell-requests/${T.reqId}/${path}`.replace(`${T.reqId}/../`, ''), headers: { ...auth(T.vend.token), 'x-vendor-id': T.vendorId }, payload: {} })
      expect(res.statusCode, `${method} ${path}`).toBe(403)
    }
  })

  it('admin: stats, list, assign, approve, complete over HTTP', async () => {
    const H = auth(T.admin.token)
    const stats = await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests/stats', headers: H })
    expect(stats.statusCode).toBe(200)
    expect(stats.json().data.total).toBeGreaterThanOrEqual(1)

    const list = (await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests?status=pending&limit=5', headers: H })).json().data
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.counts).toHaveProperty('pending')

    const base = `/api/v1/manage/sell-requests/${T.reqId}`
    expect((await app.inject({ method: 'POST', url: `${base}/approve`, headers: H })).json().code).toBe('NO_VENDOR')
    const asg = await app.inject({ method: 'POST', url: `${base}/assign-vendor`, headers: H, payload: { vendorId: T.vendorId } })
    expect(asg.json().data.status).toBe('IN_PROGRESS')
    expect((await app.inject({ method: 'POST', url: `${base}/approve`, headers: H })).json().data.status).toBe('APPROVED')
    expect((await app.inject({ method: 'POST', url: `${base}/complete`, headers: H })).json().data.status).toBe('COMPLETED')
    expect((await app.inject({ method: 'POST', url: `${base}/approve`, headers: H })).statusCode).toBe(409)
    // exchange-only route: a plain sell request cannot be linked to an order
    const lk = await app.inject({ method: 'POST', url: `${base}/link-order`, headers: H, payload: { orderNumber: 'X-1' } })
    expect(lk.statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `${base}/link-order`, headers: auth(T.vend.token), payload: { orderNumber: 'X-1' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests/not-a-uuid', headers: H })).statusCode).toBe(400)
  })

  it('admin can create on behalf of a walk-in and manage the catalogue/settings', async () => {
    const H = auth(T.admin.token)
    const r = await app.inject({ method: 'POST', url: '/api/v1/manage/sell-requests', headers: H, payload: {
      type: 'EXCHANGE', model: 'Samsung S22', variant: '256GB', color: 'Green', imei: luhn(uniq14()), qa,
      customer: { name: 'Walk In', phone: '+91 98765 43210' }, exchange: { newProduct: 'S24', newProductPrice: 80000 },
    } })
    expect(r.statusCode).toBe(201)
    expect(r.json().data.exchange.payable).toBe(80000 - r.json().data.quote)
    const s = await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests/settings', headers: H })
    expect(s.statusCode).toBe(200)
    expect(s.json().data.rules.bodyDents).toBe(8)
    const m = await app.inject({ method: 'GET', url: '/api/v1/manage/sell-requests/models', headers: H })
    expect(m.json().data.length).toBeGreaterThan(5)
  })
})
