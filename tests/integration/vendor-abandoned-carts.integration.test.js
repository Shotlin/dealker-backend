/**
 * Vendor abandoned carts — integration tests against a REAL Postgres + Redis.
 *
 * Opt-in (never runs against a dev database by accident):
 *   VAC_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=dealker_abcart_test DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   npx vitest run tests/integration/vendor-abandoned-carts.integration.test.js
 * The target database must already be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = !!process.env.VAC_TEST_DB
const d = enabled ? describe : describe.skip

let q, pool, redis, S, repoCore, cartRepo

d('vendor abandoned carts (real database)', () => {
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const V = {}
  let n = 0

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query
    pool = db.pool
    redis = (await import('../../src/config/redis.js')).redis
    S = await import('../../src/modules/vendor-abandoned-carts/vendor-abandoned-carts.service.js')
    repoCore = new (await import('../../src/modules/abandoned-carts/abandoned-carts.repository.js')).AbandonedCartsRepository()
    cartRepo = new (await import('../../src/modules/cart/cart.repository.js')).CartRepository()

    for (const k of ['a', 'b']) {
      const vendor = await one(`INSERT INTO vendors (name, slug, email, phone) VALUES ($1,$2,$3,$4) RETURNING id`, [`Vendor ${k}`, `${k}-${rand()}`, `${k}${rand()}@t.io`, '6' + rand()])
      const shop = await one(
        `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
         VALUES ($1,$2,$3,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$4,10,true) RETURNING id`,
        [`Shop ${k}`, `s-${k}-${rand()}`, 'T' + rand().slice(0, 6), vendor.id])
      V[k] = { id: vendor.id, shopId: shop.id }
    }
  })

  afterAll(async () => {
    await redis?.quit().catch(() => {})
    await pool?.end().catch(() => {})
  })

  const product = async (vendor, name, price, stock = 20) => {
    const p = await one(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ($1,$2,$3,'VENDOR',$4,true) RETURNING id`, [name, `p-${rand()}`, price, vendor.id])
    await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,$3,$4,true)`, [vendor.shopId, p.id, price, stock])
    return { id: p.id, name, price, shopId: vendor.shopId }
  }
  const customer = async (name = 'Rohit Sharma', prefs = null) => {
    const phone = '8' + rand()
    if (prefs) {
      return (await one(`INSERT INTO users (phone, name, role, notification_preferences) VALUES ($1,$2,'CUSTOMER',$3::jsonb) RETURNING id`, [phone, name, JSON.stringify(prefs)])).id
    }
    return (await one(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, [phone, name])).id
  }

  /** A customer with a cart (in Redis) + a recorded OPEN episode, like the sweep worker would leave. */
  const abandon = async (userId, lines, priceMode = 'retail') => {
    await cartRepo.saveCart(userId, lines.map((l) => ({ productId: l.p.id, shopId: l.p.shopId, quantity: l.qty })), priceMode)
    const items = lines.map((l) => ({
      productId: l.p.id, shopId: l.p.shopId, name: l.p.name, thumbnailUrl: null, unit: null,
      quantity: l.qty, effectivePrice: l.p.price, price: l.p.price, lineTotal: l.p.price * l.qty,
    }))
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0)
    const { id } = await repoCore.recordAbandonment(userId, { items, subtotal }, Date.now() - 3600_000, { score: 1, breakdown: {} }, priceMode)
    return id
  }
  const ctx = { userId: null, fastify: null }

  it('a vendor sees only their own lines and totals, never the customer contact', async () => {
    const pa = await product(V.a, 'Phone A', 50000)
    const pb = await product(V.b, 'Case B', 999)
    const user = await customer('Rohit Sharma')
    const id = await abandon(user, [{ p: pa, qty: 1 }, { p: pb, qty: 2 }])

    const listA = await S.list(V.a.id, { channel: 'ALL' })
    const rowA = listA.data.find((r) => r.id === id)
    expect(rowA.value).toBe(50000) // not 51998
    expect(rowA.item_count).toBe(1)
    expect(rowA.customer).toBe('Rohit S.')
    expect(rowA.channel).toBe('B2C')
    expect(rowA.state).toBe('ABANDONED')

    const dA = await S.detail(V.a.id, id)
    expect(dA.items.map((i) => i.name)).toEqual(['Phone A'])
    expect(dA.total).toBe(50000)
    expect(JSON.stringify(dA)).not.toContain('Case B')
    expect(JSON.stringify(dA)).not.toMatch(/"(phone|email|user_id|userId|customer_phone)"/)
    expect(JSON.stringify(listA)).not.toMatch(/"(phone|email|user_id|userId)"/)

    const dB = await S.detail(V.b.id, id)
    expect(dB.items.map((i) => i.name)).toEqual(['Case B'])
    expect(dB.total).toBe(1998)
  })

  it('a vendor with no line in the cart cannot see it', async () => {
    const pa = await product(V.a, 'Only A', 100)
    const id = await abandon(await customer(), [{ p: pa, qty: 1 }])
    await expect(S.detail(V.b.id, id)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 })
    expect((await S.list(V.b.id, {})).data.find((r) => r.id === id)).toBeUndefined()
  })

  it('retail and wholesale carts are separate episodes with their own channel', async () => {
    const pa = await product(V.a, 'Dual', 1000)
    const user = await customer()
    const retail = await abandon(user, [{ p: pa, qty: 1 }], 'retail')
    const wholesale = await abandon(user, [{ p: pa, qty: 10 }], 'wholesale')
    expect(retail).not.toBe(wholesale)

    const b2b = (await S.list(V.a.id, { channel: 'B2B' })).data.map((r) => r.id)
    const b2c = (await S.list(V.a.id, { channel: 'B2C' })).data.map((r) => r.id)
    expect(b2b).toContain(wholesale)
    expect(b2b).not.toContain(retail)
    expect(b2c).toContain(retail)
    expect(b2c).not.toContain(wholesale)
    expect((await S.detail(V.a.id, wholesale)).channel).toBe('B2B')
  })

  it('reminds about the vendor’s own products only, and each vendor has an independent cooldown', async () => {
    const pa = await product(V.a, 'Remind A', 700)
    const pb = await product(V.b, 'Remind B', 300)
    const user = await customer('Pooja Kumari')
    const id = await abandon(user, [{ p: pa, qty: 1 }, { p: pb, qty: 1 }])

    const out = await S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)
    expect(out.reminder.sent).toBe(1)
    const rowA = await one(`SELECT product_ids, vendor_id, notification_id FROM abandoned_cart_vendor_reminders WHERE abandoned_cart_id = $1 AND vendor_id = $2`, [id, V.a.id])
    expect(rowA.product_ids).toEqual([pa.id]) // never B's product
    const notif = await one(`SELECT title, body, type, user_id FROM notifications WHERE id = $1`, [rowA.notification_id])
    expect(notif.user_id).toBe(user)
    expect(notif.type).toBe('abandoned_cart')
    expect(notif.body).toContain('Remind A')
    expect(notif.body).not.toContain('Remind B')

    // vendor A is now in cooldown…
    await expect(S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)).rejects.toMatchObject({ code: 'COOLDOWN', statusCode: 429 })
    // …vendor B is not affected
    const outB = await S.remind(V.b.id, id, { templateKey: 'HELP' }, ctx)
    expect(outB.reminder.sent).toBe(1)
    const notifB = await one(`SELECT body FROM notifications WHERE id = (SELECT notification_id FROM abandoned_cart_vendor_reminders WHERE abandoned_cart_id=$1 AND vendor_id=$2)`, [id, V.b.id])
    expect(notifB.body).not.toContain('Remind A')

    // vendor A cannot see B's reminder in their own timeline
    const dA = await S.detail(V.a.id, id)
    expect(dA.timeline.filter((t) => t.kind === 'MY_REMINDER')).toHaveLength(1)
  })

  it('refuses to remind about someone else’s product', async () => {
    const pa = await product(V.a, 'Mine', 100)
    const pb = await product(V.b, 'Theirs', 100)
    const id = await abandon(await customer(), [{ p: pa, qty: 1 }, { p: pb, qty: 1 }])
    await expect(S.remind(V.a.id, id, { templateKey: 'GENTLE', productIds: [pb.id] }, ctx)).rejects.toMatchObject({ code: 'NOT_YOUR_PRODUCT', statusCode: 403 })
    expect(await one(`SELECT COUNT(*)::int n FROM abandoned_cart_vendor_reminders WHERE abandoned_cart_id = $1`, [id])).toEqual({ n: 0 })
  })

  it('can remind about just one of the vendor’s products', async () => {
    const p1 = await product(V.a, 'Alpha', 100)
    const p2 = await product(V.a, 'Beta', 200)
    const id = await abandon(await customer(), [{ p: p1, qty: 1 }, { p: p2, qty: 1 }])
    await S.remind(V.a.id, id, { templateKey: 'GENTLE', productIds: [p2.id] }, ctx)
    const row = await one(`SELECT product_ids, notification_id FROM abandoned_cart_vendor_reminders WHERE abandoned_cart_id = $1`, [id])
    expect(row.product_ids).toEqual([p2.id])
    const notif = await one(`SELECT body FROM notifications WHERE id = $1`, [row.notification_id])
    expect(notif.body).toContain('Beta')
    expect(notif.body).not.toContain('Alpha')
  })

  it('the preview is exactly what gets sent, for any product selection', async () => {
    const p1 = await product(V.a, 'Prev One', 100)
    const p2 = await product(V.a, 'Prev Two', 200)
    const id = await abandon(await customer('Asha Rao'), [{ p: p1, qty: 1 }, { p: p2, qty: 1 }])
    const pv = await S.preview(V.a.id, id, { templateKey: 'GENTLE', productIds: [p2.id] })
    expect(pv.body).toContain('Prev Two')
    expect(pv.body).not.toContain('Prev One')
    expect(pv.product_count).toBe(1)
    await S.remind(V.a.id, id, { templateKey: 'GENTLE', productIds: [p2.id] }, ctx)
    const sent = await one(`SELECT n.title, n.body FROM abandoned_cart_vendor_reminders r JOIN notifications n ON n.id = r.notification_id WHERE r.abandoned_cart_id = $1`, [id])
    expect(sent).toEqual({ title: pv.title, body: pv.body })
    // previewing never records a reminder
    expect((await one(`SELECT COUNT(*)::int n FROM abandoned_cart_vendor_reminders WHERE abandoned_cart_id = $1`, [id])).n).toBe(1)
  })

  it('caps reminders per cart per vendor after the cooldown passes', async () => {
    const pa = await product(V.a, 'Cap', 100)
    const id = await abandon(await customer(), [{ p: pa, qty: 1 }])
    for (let i = 0; i < 3; i++) {
      await S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)
      await q(`UPDATE abandoned_cart_vendor_reminders SET created_at = created_at - INTERVAL '25 hours' WHERE abandoned_cart_id = $1`, [id])
    }
    await expect(S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)).rejects.toMatchObject({ code: 'LIMIT_REACHED' })
  })

  it('respects a customer who turned promotions off', async () => {
    const pa = await product(V.a, 'Optout', 100)
    const id = await abandon(await customer('Quiet One', { promotions: false }), [{ p: pa, qty: 1 }])
    const d1 = await S.detail(V.a.id, id)
    expect(d1.reminder.can_remind).toBe(false)
    expect(d1.reminder.reason).toBe('OPTED_OUT')
    await expect(S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)).rejects.toMatchObject({ code: 'OPTED_OUT' })
  })

  it('closes the episode instead of nagging when the customer already removed the item', async () => {
    const pa = await product(V.a, 'Gone', 100)
    const user = await customer()
    const id = await abandon(user, [{ p: pa, qty: 1 }])
    await cartRepo.saveCart(user, [], 'retail') // customer emptied the cart; episode snapshot is stale
    await expect(S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)).rejects.toMatchObject({ code: 'CART_CHANGED', statusCode: 409 })
    expect((await one(`SELECT status FROM abandoned_carts WHERE id = $1`, [id])).status).toBe('EXPIRED')
  })

  it('does not let many sellers pile onto one customer (daily cap across senders)', async () => {
    const pa = await product(V.a, 'Pile', 100)
    const user = await customer()
    const id = await abandon(user, [{ p: pa, qty: 1 }])
    // four earlier pushes today from other senders
    for (let i = 0; i < 4; i++) {
      const nt = await one(`INSERT INTO notifications (user_id, title) VALUES ($1,'x') RETURNING id`, [user])
      await q(`INSERT INTO abandoned_cart_notifications (abandoned_cart_id, notification_id) VALUES ($1,$2)`, [id, nt.id])
    }
    await expect(S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)).rejects.toMatchObject({ code: 'CUSTOMER_CAP' })
  })

  it('low-stock message is only available when real stock is low', async () => {
    const plenty = await product(V.a, 'Plenty', 100, 50)
    const few = await product(V.a, 'Few', 100, 3)
    const id1 = await abandon(await customer(), [{ p: plenty, qty: 1 }])
    const id2 = await abandon(await customer(), [{ p: few, qty: 1 }])
    const t1 = (await S.detail(V.a.id, id1)).reminder.templates.find((t) => t.key === 'LOW_STOCK')
    const t2 = (await S.detail(V.a.id, id2)).reminder.templates.find((t) => t.key === 'LOW_STOCK')
    expect(t1.available).toBe(false)
    expect(t2.available).toBe(true)
    expect(t2.title).toContain('3')
    await expect(S.remind(V.a.id, id1, { templateKey: 'LOW_STOCK' }, ctx)).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE' })
    await S.remind(V.a.id, id2, { templateKey: 'LOW_STOCK' }, ctx)
  })

  it('counts an order as recovered for a vendor only when the order included that vendor', async () => {
    const pa = await product(V.a, 'Conv A', 1000)
    const pb = await product(V.b, 'Conv B', 500)
    const user = await customer()
    const id = await abandon(user, [{ p: pa, qty: 1 }, { p: pb, qty: 1 }])
    await S.remind(V.a.id, id, { templateKey: 'GENTLE' }, ctx)

    const order = await one(
      `INSERT INTO orders (order_number, customer_id, items, subtotal, total_payable, delivery_address)
       VALUES ($1,$2,'[]'::jsonb,500,500,'{}'::jsonb) RETURNING id`, [`T-${rand()}`, user])
    await q(`INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, shop_id) VALUES ($1,$2,$3,$4)`, [order.id, `S-${rand()}`, V.b.id, V.b.shopId])
    await repoCore.markConvertedByUserId(user, order.id, 'retail')

    expect((await S.detail(V.b.id, id)).state).toBe('ORDERED')
    expect((await S.detail(V.a.id, id)).state).toBe('CLOSED') // they bought, but not from A

    const sumB = await S.summary(V.b.id, { channel: 'ALL' })
    expect(sumB.recovered_orders).toBeGreaterThanOrEqual(1)
    const sumA = await S.summary(V.a.id, { channel: 'ALL' })
    expect(sumA.ordered_after_reminder).toBe(0)
  })

  it('the cart-clear / recovery hooks only touch the matching channel', async () => {
    const pa = await product(V.a, 'Hook', 100)
    const user = await customer()
    const retail = await abandon(user, [{ p: pa, qty: 1 }], 'retail')
    const wholesale = await abandon(user, [{ p: pa, qty: 5 }], 'wholesale')
    await repoCore.markRecoveredByUserId(user, 'retail')
    expect((await one(`SELECT status FROM abandoned_carts WHERE id = $1`, [retail])).status).toBe('RECOVERED')
    expect((await one(`SELECT status FROM abandoned_carts WHERE id = $1`, [wholesale])).status).toBe('OPEN')
  })

  it('summary reports carts, pending value and change vs the previous period', async () => {
    const pa = await product(V.a, 'Sum', 250)
    const before = await S.summary(V.a.id, { channel: 'B2C', days: 30 })
    await abandon(await customer(), [{ p: pa, qty: 2 }])
    const after = await S.summary(V.a.id, { channel: 'B2C', days: 30 })
    expect(after.carts).toBe(before.carts + 1)
    expect(after.pending_value).toBe(before.pending_value + 500)
    expect(after.recovery_rate).toBeGreaterThanOrEqual(0)
    n++
  })
})
