/**
 * Vendor returns — HTTP layer + data rules against the real app and a REAL Postgres.
 *
 * Opt-in (never runs against a dev database by accident):
 *   VRET_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=vret_test DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… \
 *   npx vitest run tests/integration/vendor-returns.integration.test.js
 * The target database must already be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'

const d = process.env.VRET_TEST_DB ? describe : describe.skip

d('vendor returns (real database)', () => {
  let app, q, pool
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const auth = (t) => ({ authorization: `Bearer ${t}` })
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const get = (url, who) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(who.token) })
  const post = (url, who, payload) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: auth(who.token), payload })

  const mkUser = async (role, name) => {
    const u = await one(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: u.id, token: jwt.sign({ id: u.id, role, session_version: u.session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkVendor = async (name) => {
    const n = rand()
    const v = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [name, `v-${n}`, `v${n}@x.test`, `7${n}`])
    const user = await mkUser('CUSTOMER', `${name} owner`)
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [v.id, user.id])
    return { ...user, vendorId: v.id }
  }

  /** A delivered order with one parcel per vendor; returns ids of the two order lines. */
  const deliveredOrder = async (customer, vA, vB) => {
    const num = `T-${rand()}`
    const o = await one(
      `INSERT INTO orders (order_number, customer_id, items, subtotal, total_payable, delivery_address, status, payment_status, delivered_at)
       VALUES ($1,$2,'[]'::jsonb,1500,1500,'{"line1":"1 Road","city":"Kolkata","phone":"9999999999"}'::jsonb,'DELIVERED','PAID', NOW()) RETURNING id`,
      [num, customer.id])
    const lines = {}
    for (const [k, v, price] of [['a', vA, 1000], ['b', vB, 500]]) {
      const so = await one(`INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, status) VALUES ($1,$2,$3,'DELIVERED') RETURNING id`, [o.id, `SO-${rand()}`, v.vendorId])
      const oi = await one(
        `INSERT INTO order_items (order_id, seller_order_id, product_name, unit_price, quantity, subtotal) VALUES ($1,$2,$3,$4,1,$4) RETURNING id`,
        [o.id, so.id, `Item ${k.toUpperCase()}`, price])
      lines[k] = oi.id
    }
    return { id: o.id, number: num, lines }
  }

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query
    pool = db.pool
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    T.cust = await mkUser('CUSTOMER', 'Rohit Sharma')
    T.admin = await mkUser('ADMIN', 'Team Admin')
    T.a = await mkVendor('Vendor A')
    T.b = await mkVendor('Vendor B')
    T.c = await mkVendor('Vendor C (unrelated)')
    T.order = await deliveredOrder(T.cust, T.a, T.b)
  }, 90000)

  afterAll(async () => {
    await app?.close()
    await pool?.end().catch(() => {})
  })

  const itemsReturn = async (orderId, orderItemId, extra = {}) => post('/refund-requests', T.cust, {
    orderId, itemScope: 'SPECIFIC', description: 'Phone screen has a green line', reasonCode: 'SCREEN_DISPLAY',
    productIds: undefined, ...extra,
  })

  it('requires a vendor login (anonymous 401, customer / admin 403)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/manage/returns' })).statusCode).toBe(401)
    expect((await get('/manage/returns', T.cust)).statusCode).toBe(403)
    expect((await get('/manage/returns/summary', T.admin)).statusCode).toBe(403)
  })

  it('a return on vendor A\'s line is invisible to vendor B and to an unrelated vendor', async () => {
    // Customer-side create path needs product ids; insert the request directly the way create() stores it.
    const rr = await one(
      `INSERT INTO refund_requests (order_id, customer_id, scope, items, reason, reason_code, refund_destination, computed_amount, evidence, source)
       VALUES ($1,$2,'ITEMS',$3::jsonb,'Green line on the screen','SCREEN_DISPLAY','WALLET',1000,$4::jsonb,'CUSTOMER') RETURNING id`,
      [T.order.id, T.cust.id,
        JSON.stringify([{ orderItemId: T.order.lines.a, name: 'Item A', quantity: 1, unitPrice: 1000, lineTotal: 1000 }]),
        JSON.stringify([{ url: 'https://example.com/p1.jpg', kind: 'IMAGE' }])])
    T.rr = rr.id

    const a = (await get('/manage/returns', T.a)).json()
    expect(a.data.map((r) => r.id)).toContain(rr.id)
    expect(a.data[0].stage).toBe('NEEDS_RESPONSE')
    expect(a.data[0].at_risk_amount).toBe(1000)
    expect(a.data[0].item_count).toBe(1)

    for (const other of [T.b, T.c]) {
      expect((await get('/manage/returns', other)).json().data.map((r) => r.id)).not.toContain(rr.id)
      expect((await get(`/manage/returns/${rr.id}`, other)).statusCode).toBe(404)
      expect((await post(`/manage/returns/${rr.id}/respond`, other, { stance: 'AGREE', note: 'sure' })).statusCode).toBe(404)
      expect((await post(`/manage/returns/${rr.id}/chat`, other, {})).statusCode).toBe(404)
    }
  })

  it('detail shows reason, photos, only my lines, the journey — and never the customer contact', async () => {
    const res = await get(`/manage/returns/${T.rr}`, T.a)
    expect(res.statusCode).toBe(200)
    const r = res.json().data
    expect(r.return_number).toMatch(/^RTN[0-9A-F]{8}$/)
    expect(r.reason_label).toBe('Screen / display problem')
    expect(r.evidence).toEqual([{ url: 'https://example.com/p1.jpg', kind: 'IMAGE' }])
    expect(r.items.map((i) => i.name)).toEqual(['Item A'])
    expect(r.customer).toEqual({ name: 'Rohit Sharma' })
    expect(r.can_respond).toBe(true)
    expect(r.timeline[0].key).toBe('REQUESTED')
    const raw = JSON.stringify(r)
    expect(raw).not.toContain('9999999999') // delivery phone
    expect(raw).not.toContain('Kolkata')
    expect(raw).not.toContain('refund_destination')
    expect(raw).not.toContain('Item B')
  })

  it('a full-order return reaches both vendors, each seeing only their own parcel value', async () => {
    const o2 = await deliveredOrder(T.cust, T.a, T.b)
    const rr = await one(
      `INSERT INTO refund_requests (order_id, customer_id, scope, reason, refund_destination, computed_amount, source)
       VALUES ($1,$2,'FULL_ORDER','Changed my mind','WALLET',1500,'CUSTOMER') RETURNING id`, [o2.id, T.cust.id])
    const ra = (await get(`/manage/returns/${rr.id}`, T.a)).json().data
    const rb = (await get(`/manage/returns/${rr.id}`, T.b)).json().data
    expect(ra.at_risk_amount).toBe(1000)
    expect(rb.at_risk_amount).toBe(500)
    expect(ra.items.map((i) => i.name)).toEqual(['Item A'])
    expect(rb.items.map((i) => i.name)).toEqual(['Item B'])
    expect((await get(`/manage/returns/${rr.id}`, T.c)).statusCode).toBe(404)
  })

  it('summary and filters count what needs an answer', async () => {
    const s = (await get('/manage/returns/summary', T.a)).json().data
    expect(s.open).toBeGreaterThanOrEqual(2)
    expect(s.needs_response).toBe(s.open)
    expect((await get('/manage/returns?state=needs_response', T.a)).json().data.length).toBe(s.needs_response)
    expect((await get('/manage/returns?state=closed', T.a)).json().data.length).toBe(0)
    const byNumber = (await get(`/manage/returns?search=${T.order.number}`, T.a)).json()
    expect(byNumber.data.map((r) => r.id)).toEqual([T.rr])
    expect(byNumber.pagination.total).toBe(1)
    const so = (await q(`SELECT id FROM seller_orders WHERE order_id = $1 AND vendor_id = $2`, [T.order.id, T.a.vendorId])).rows[0].id
    expect((await get(`/manage/returns?sellerOrderId=${so}`, T.a)).json().data.map((r) => r.id)).toEqual([T.rr])
    expect((await get(`/manage/returns?sellerOrderId=${so}`, T.b)).json().data).toHaveLength(0) // someone else's parcel
  })

  it('validates the answer, saves it, and puts it in the staff case file', async () => {
    expect((await post(`/manage/returns/${T.rr}/respond`, T.a, { stance: 'MAYBE', note: 'x'.repeat(5) })).statusCode).toBe(400)
    expect((await post(`/manage/returns/${T.rr}/respond`, T.a, { stance: 'AGREE', note: 'ok' })).statusCode).toBe(400) // too short
    expect((await post(`/manage/returns/${T.rr}/respond`, T.a, { stance: 'AGREE', note: 'fine', evidence: [{ url: 'not a url', kind: 'IMAGE' }] })).statusCode).toBe(400)

    await q(`UPDATE refund_requests SET investigation_status = 'WAITING_SELLER' WHERE id = $1`, [T.rr])
    const res = await post(`/manage/returns/${T.rr}/respond`, T.a, {
      stance: 'DISPUTE', note: 'Screen was perfect when packed, see the video.',
      evidence: [{ url: 'https://example.com/pack.mp4', kind: 'VIDEO' }, { url: 'https://example.com/pack.jpg', kind: 'IMAGE' }],
    })
    expect(res.statusCode).toBe(200)
    const r = res.json().data
    expect(r.stage).toBe('WITH_TEAM')
    expect(r.my_stance).toBe('DISPUTE')
    expect(r.response.evidence).toHaveLength(2)
    expect(r.timeline.some((s) => s.key === 'SELLER_RESPONDED' && /disputed/.test(s.title))).toBe(true)

    const ev = await q(`SELECT side, kind, title FROM refund_case_evidence WHERE refund_request_id = $1 ORDER BY created_at`, [T.rr])
    expect(ev.rows.map((e) => e.side)).toEqual(['SELLER', 'SELLER'])
    const ce = await q(`SELECT type, party, title FROM refund_case_events WHERE refund_request_id = $1 AND type = 'SELLER_RESPONDED'`, [T.rr])
    expect(ce.rows).toHaveLength(1)
    expect(ce.rows[0].party).toBe('SELLER')
    expect((await one(`SELECT investigation_status s FROM refund_requests WHERE id = $1`, [T.rr])).s).toBe('OPEN')

    // Answering again replaces — it never piles up duplicates.
    const again = await post(`/manage/returns/${T.rr}/respond`, T.a, { stance: 'AGREE', note: 'On reflection the customer is right.' })
    expect(again.json().data.my_stance).toBe('AGREE')
    expect((await q(`SELECT 1 FROM refund_case_evidence WHERE refund_request_id = $1`, [T.rr])).rows).toHaveLength(0)
    expect((await q(`SELECT 1 FROM refund_vendor_responses WHERE refund_request_id = $1`, [T.rr])).rows).toHaveLength(1)
    // The vendor's answer does not move money or change the request itself.
    expect((await one(`SELECT status FROM refund_requests WHERE id = $1`, [T.rr])).status).toBe('PENDING')
  })

  it('chat: vendor opens a return chat once, the team replies, the vendor reads it — and the customer never sees it', async () => {
    const first = await post(`/manage/returns/${T.rr}/chat`, T.a, { message: 'Customer says screen is broken, please help me prove it was fine.' })
    expect(first.statusCode).toBe(200)
    const chat = first.json().data
    expect(chat.ticket_number).toMatch(/^TKT-/)
    const second = await post(`/manage/returns/${T.rr}/chat`, T.a, {})
    expect(second.json().data.ticket_id).toBe(chat.ticket_id) // get-or-create

    const t = await one(`SELECT user_id, channel, category, order_id, refund_request_id FROM support_tickets WHERE id = $1`, [chat.ticket_id])
    expect(t).toMatchObject({ user_id: T.a.id, channel: 'VENDOR_APP', category: 'RETURN_REFUND', order_id: T.order.id, refund_request_id: T.rr })

    // Existing ticket endpoints carry the messages — scoped to the vendor user.
    const sent = await post(`/support/tickets/${chat.ticket_id}/messages`, T.a, { body: 'Here is my packing video.' })
    expect(sent.statusCode).toBe(201)
    const reply = await app.inject({ method: 'POST', url: `/api/v1/admin/support/tickets/${chat.ticket_id}/messages`, headers: auth(T.admin.token), payload: { body: 'Thanks, we are checking.' } })
    expect([200, 201, 403]).toContain(reply.statusCode)
    const thread = (await get(`/support/tickets/${chat.ticket_id}`, T.a)).json().data
    expect(thread.messages.length).toBeGreaterThanOrEqual(2)
    expect((await get(`/support/tickets/${chat.ticket_id}`, T.cust)).statusCode).toBe(404) // the customer cannot open the vendor's chat
    expect((await get(`/support/tickets/${chat.ticket_id}`, T.b)).statusCode).toBe(404)
    expect((await get('/support/tickets', T.cust)).json().data.map((x) => x.id)).not.toContain(chat.ticket_id)

    // The detail now links the chat, and the list carries its unread counter.
    const det = (await get(`/manage/returns/${T.rr}`, T.a)).json().data
    expect(det.chat.ticket_id).toBe(chat.ticket_id)

    // Staff "start chat with the customer" must NOT reuse the seller's conversation.
    const { supportService } = await import('../../src/modules/support/support.service.js')
    const staff = await supportService.startFromContext({ refundRequestId: T.rr, actorId: T.admin.id })
    expect(staff.ticket.id).not.toBe(chat.ticket_id)
    expect(staff.ticket.customer.id).toBe(T.cust.id)
  })

  it('a closed return can no longer be answered, but stays readable', async () => {
    await q(`UPDATE refund_requests SET status = 'REJECTED', resolved_at = NOW(), admin_notes = 'Not eligible' WHERE id = $1`, [T.rr])
    const res = await post(`/manage/returns/${T.rr}/respond`, T.a, { stance: 'AGREE', note: 'too late now' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('RETURN_CLOSED')
    const r = (await get(`/manage/returns/${T.rr}`, T.a)).json().data
    expect(r.stage).toBe('REJECTED')
    expect(r.can_respond).toBe(false)
    expect(r.team_note).toBe('Not eligible')
    expect((await get('/manage/returns?state=closed', T.a)).json().data.map((x) => x.id)).toContain(T.rr)
  })

  it('a return filed through the real customer endpoint notifies the sellers involved (vendor app only)', async () => {
    const o4 = await deliveredOrder(T.cust, T.a, T.b)
    const res = await post('/refund-requests', T.cust, { orderId: o4.id, itemScope: 'ALL', description: 'It stopped charging', reasonCode: 'BATTERY' })
    expect(res.statusCode).toBe(201)
    const rid = res.json().data.id
    let rows = []
    for (let i = 0; i < 20 && rows.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100))
      rows = (await q(`SELECT user_id, title, data FROM notifications WHERE type = 'RETURN' AND data->>'refundRequestId' = $1`, [rid])).rows
    }
    expect(rows.map((r) => r.user_id).sort()).toEqual([T.a.id, T.b.id].sort())
    expect((await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'RETURN'`, [T.c.id])).rows).toHaveLength(0)
    // …and it is visible in the vendor's list straight away.
    expect((await get('/manage/returns?state=needs_response', T.b)).json().data.map((r) => r.id)).toContain(rid)
  })

  it('the customer still gets the exact same refund-request view (no vendor data leaks)', async () => {
    const o3 = await deliveredOrder(T.cust, T.a, T.b)
    await q(
      `INSERT INTO refund_requests (order_id, customer_id, scope, reason, refund_destination, computed_amount, source)
       VALUES ($1,$2,'FULL_ORDER','x reason','WALLET',1500,'CUSTOMER')`, [o3.id, T.cust.id])
    const r = (await get(`/refund-requests/order/${o3.id}`, T.cust)).json().data
    expect(r.status).toBe('PENDING')
    expect(Object.keys(r)).not.toContain('stance')
    expect(JSON.stringify(r)).not.toContain('SELLER_RESPONDED')
  })
})
