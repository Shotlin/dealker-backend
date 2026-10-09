/**
 * B2B abandoned carts — real Postgres.
 *   ABB_TEST_DB=1 DB_HOST=… DB_PORT=… DB_NAME=… DB_USER=… DB_PASSWORD=… npx vitest run tests/integration/abandoned-b2b.integration.test.js
 */
import { beforeAll, describe, expect, it } from 'vitest'

const d = process.env.ABB_TEST_DB ? describe : describe.skip

d('B2B abandoned carts (real database)', () => {
  let q, svc
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const mkOrder = async (hoursOld, { status = 'PENDING_PAYMENT', pay = 'UNPAID', subtotal = 12000 } = {}) => {
    const req = (await q(`INSERT INTO b2b_requirements (requirement_number, buyer_vendor_id, posted_by_type, title, product_name, quantity_needed, status, response_deadline)
      VALUES ($1,$2,'VENDOR','Bulk',$3,5,'AWARDED', NOW() + interval '5 days') RETURNING id`, ['REQ-' + rand(), F.buyer.id, 'Item ' + rand()])).rows[0]
    const quote = (await q(`INSERT INTO b2b_quotes (requirement_id, seller_vendor_id, quantity_offered, unit_price) VALUES ($1,$2,5,1000) RETURNING id`, [req.id, F.seller.id])).rows[0]
    return (await q(`INSERT INTO b2b_orders (order_number, requirement_id, quote_id, buyer_vendor_id, seller_vendor_id, quantity, unit_price, subtotal, status, payment_status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,5,$6,$6,$7,$8, NOW() - ($9 || ' hours')::interval, NOW() - ($9 || ' hours')::interval) RETURNING id`,
      ['AB-' + rand(), req.id, quote.id, F.buyer.id, F.seller.id, subtotal, status, pay, String(hoursOld)])).rows[0]
  }
  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    const { AbandonedB2bService } = await import('../../src/modules/abandoned-b2b/abandoned-b2b.service.js')
    svc = new AbandonedB2bService()
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'AB Admin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.buyer = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('AB Buyer',$1,$2,$3,'ACTIVE') RETURNING id`, ['abb-' + rand(), `a${rand()}@t.io`, '65' + rand()])).rows[0]
    F.seller = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('AB Seller',$1,$2,$3,'ACTIVE') RETURNING id`, ['abs-' + rand(), `s${rand()}@t.io`, '66' + rand()])).rows[0]
  })

  it('only stale unpaid orders count as abandoned; fresh, paid and cancelled ones do not', async () => {
    const before = await svc.summary(24)
    const stale = await mkOrder(30); await mkOrder(2); await mkOrder(30, { pay: 'ESCROW_HELD', status: 'PAID' }); await mkOrder(30, { status: 'CANCELLED' })
    const after = await svc.summary(24)
    expect(after.open - before.open).toBe(1)
    expect(Math.round(after.atRiskValue - before.atRiskValue)).toBe(12000)
    const list = await svc.list({ state: 'OPEN', hours: 24, limit: 100 })
    const row = list.data.find((r) => r.id === stale.id)
    expect(row).toMatchObject({ state: 'OPEN', buyer_name: 'AB Buyer', seller_name: 'AB Seller', quantity: 5, subtotal: 12000, touches: 0 })
    expect(row.idle_hours).toBeGreaterThanOrEqual(29)
    expect((await svc.summary(1)).open).toBeGreaterThan(after.open)       // a tighter threshold catches more
  })

  it('follow-ups are logged, the latest sets the state, and a note is required', async () => {
    const o = await mkOrder(48)
    await expect(svc.followUp(o.id, { status: 'CONTACTED', note: '' }, F.admin.id)).rejects.toMatchObject({ code: 'NOTE_REQUIRED' })
    await expect(svc.followUp(o.id, { status: 'MAYBE', note: 'called' }, F.admin.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await svc.followUp(o.id, { status: 'CONTACTED', note: 'Called buyer, wants a 5% discount' }, F.admin.id)
    const h = await svc.followUp(o.id, { status: 'WILL_PAY', note: 'Will pay by Friday' }, F.admin.id)
    expect(h.map((x) => x.status)).toEqual(['WILL_PAY', 'CONTACTED'])
    expect(h[0].by_name).toBe('AB Admin')
    const row = (await svc.list({ state: 'WILL_PAY', limit: 100 })).data.find((r) => r.id === o.id)
    expect(row).toMatchObject({ state: 'WILL_PAY', follow_up_note: 'Will pay by Friday', touches: 2 })
    await svc.followUp(o.id, { status: 'LOST', note: 'Buyer went elsewhere' }, F.admin.id)
    expect((await svc.list({ state: 'LOST', limit: 100 })).data.some((r) => r.id === o.id)).toBe(true)
    await expect(svc.followUp('00000000-0000-0000-0000-000000000000', { status: 'LOST', note: 'x y z' }, F.admin.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('an order that was chased and then paid is reported as recovered, and can no longer be chased', async () => {
    const o = await mkOrder(40)
    await svc.followUp(o.id, { status: 'CONTACTED', note: 'Sent payment link again' }, F.admin.id)
    const before = await svc.summary(24)
    await q(`UPDATE b2b_orders SET status = 'PAID', payment_status = 'ESCROW_HELD' WHERE id = $1`, [o.id])
    const after = await svc.summary(24)
    expect(after.recovered - before.recovered).toBe(1)
    expect(Math.round(after.recoveredValue - before.recoveredValue)).toBe(12000)
    expect((await svc.list({ state: 'RECOVERED', limit: 100 })).data.find((r) => r.id === o.id).state).toBe('RECOVERED')
    await expect(svc.followUp(o.id, { status: 'CONTACTED', note: 'one more nudge' }, F.admin.id)).rejects.toMatchObject({ code: 'NOT_ABANDONED' })
  })

  it('search matches buyer, seller, product or order number', async () => {
    const o = await mkOrder(36)
    const num = (await q('SELECT order_number FROM b2b_orders WHERE id = $1', [o.id])).rows[0].order_number
    expect((await svc.list({ search: num, limit: 10 })).data.map((r) => r.id)).toEqual([o.id])
    expect((await svc.list({ search: 'AB Buyer', limit: 100 })).meta.total).toBeGreaterThan(0)
    expect((await svc.list({ search: 'no-such-thing', limit: 10 })).data).toEqual([])
  })
})
