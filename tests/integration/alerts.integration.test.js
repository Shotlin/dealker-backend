/**
 * Notification centre — real Postgres: the triggers that raise alerts,
 * Notification Control, per-admin read state and the feed.
 *
 *   ALERTS_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/alerts.integration.test.js
 */
import { beforeAll, describe, expect, it } from 'vitest'

const d = process.env.ALERTS_TEST_DB ? describe : describe.skip

d('notification centre (real database)', () => {
  let q, svc, listings
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const photos = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']
  const alertsOf = async (type, since) => (await q(`SELECT * FROM admin_alerts WHERE type = $1 AND id > $2 ORDER BY id`, [type, since])).rows
  const mark = async () => Number((await q(`SELECT COALESCE(MAX(id), 0) AS m FROM admin_alerts`)).rows[0].m)
  const mkOrder = async (o = {}) => (await q(
    `INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, payment_method, payment_status, delivery_address)
     VALUES ($1,$2,TRUE,$3,'[]'::jsonb,1500,1500,'ONLINE',$4,'{}'::jsonb) RETURNING id, order_number`, ['AL-' + rand(), F.customer, o.status ?? 'ORDER_PLACED', o.pay ?? 'PENDING'])).rows[0]
  const mkListing = (over = {}) => listings.create({ name: 'Alert Phone ' + rand(), categoryId: F.cat.id, condition: 'NEW', price: 5000, mrp: 6000, stock: 5,
    images: photos, ownerVendorId: F.vendor.id, ...over }, { vendorId: F.vendor.id, actorId: F.admin.id })

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const { AlertsService } = await import('../../src/modules/alerts/alerts.service.js')
    svc = new AlertsService()
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Alert Admin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.admin2 = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Alert Admin 2','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.customer = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Alert Customer','CUSTOMER') RETURNING id`, ['7' + rand()])).rows[0].id
    F.vendor = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Alert Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['av-' + rand(), `a${rand()}@t.io`, '71' + rand()])).rows[0]
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
             VALUES ('AS',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,5,true)`, ['as-' + rand(), 'A' + rand().slice(0, 6), F.vendor.id])
    F.cat = (await q(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, ['Alert Cat ' + rand(), 'ac-' + rand()])).rows[0]
    await q(`UPDATE alert_settings SET enabled = TRUE, min_amount = CASE WHEN type IN ('WALLET_CREDIT','WALLET_DEBIT') THEN 500 ELSE NULL END`)
  })

  it('all 23 required alert types are configured, with labels and groups', async () => {
    const s = await svc.settings()
    const types = s.map((x) => x.type)
    for (const t of ['NEW_ORDER', 'ORDER_CANCELLED', 'PAYMENT_RECEIVED', 'AUCTION_WON', 'AUCTION_STARTED', 'AUCTION_ENDING', 'CAMPAIGN_PURCHASED', 'PRODUCT_APPROVED', 'PRODUCT_REJECTED',
      'QC_FAILED', 'REFUND_REQUEST', 'EXCHANGE_REQUEST', 'NEW_VENDOR', 'NEW_CUSTOMER', 'SUBSCRIPTION_EXPIRING', 'WALLET_CREDIT', 'WALLET_DEBIT', 'LOW_STOCK', 'DELIVERY_FAILED', 'RTO', 'NEW_REVIEW', 'NEW_SUPPORT_TICKET']) {
      expect(types, t).toContain(t)
    }
    expect(s.every((x) => x.label && x.grp)).toBe(true)
  })

  it('orders: new order, payment received (with advance wording), cancellation', async () => {
    const m = await mark()
    const o = await mkOrder()
    const [n] = await alertsOf('NEW_ORDER', m)
    expect(n).toMatchObject({ severity: 'INFO', entity_type: 'order', link: `/orders/${o.id}` })
    expect(n.title).toContain(o.order_number)
    expect(n.title).toContain('₹1,500')
    await q(`UPDATE orders SET payment_status = 'PARTIALLY_PAID', amount_paid = 500, amount_due = 1000 WHERE id = $1`, [o.id])
    const [p] = await alertsOf('PAYMENT_RECEIVED', m)
    expect(p.title).toContain('₹500')
    expect(p.body).toMatch(/due on delivery/)
    await q(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [o.id])
    expect((await alertsOf('ORDER_CANCELLED', m)).length).toBe(1)
    await q(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [o.id]) // no change → no duplicate
    expect((await alertsOf('ORDER_CANCELLED', m)).length).toBe(1)
  })

  it('refund request, exchange request and sell lead', async () => {
    const m = await mark()
    const o = await mkOrder()
    await q(`INSERT INTO refund_requests (order_id, customer_id, scope, reason, refund_destination, computed_amount) VALUES ($1,$2,'FULL_ORDER','Screen cracked on arrival','WALLET',1500)`, [o.id, F.customer])
    expect((await alertsOf('REFUND_REQUEST', m))[0].title).toContain('₹1,500')
    const sell = (type, ex) => q(`INSERT INTO sell_requests (code, type, status, user_id, customer_name, customer_phone, model_name, variant, color, category, imei, qa, condition, base_price, quote, expected_price, exchange)
      VALUES ($1,$2,'PENDING',$3,'Cust','9000000000','Pixel 8','128','Black','Smartphone',$4,'{}'::jsonb,'GOOD',1000,900,1000,$5)`, [`C-${rand()}`, type, F.customer, rand() + '123456', ex])
    await sell('EXCHANGE', JSON.stringify({ newProduct: 'iPhone 15' })); await sell('SELL_TO_AB', null)
    expect((await alertsOf('EXCHANGE_REQUEST', m)).length).toBe(1)
    expect((await alertsOf('SELL_REQUEST', m)).length).toBe(1)
  })

  it('catalogue: approval, rejection, QC failure and low stock (once per crossing)', async () => {
    const m = await mark()
    const l = await mkListing()                       // vendor listing → pending
    await listings.approve(l.id, F.admin.id)
    expect((await alertsOf('PRODUCT_APPROVED', m)).length).toBe(1)
    await listings.reject(l.id, 'Photos are blurry', F.admin.id)
    expect((await alertsOf('PRODUCT_REJECTED', m))[0].body).toBe('Photos are blurry')
    await q(`UPDATE shop_products SET qc_status = 'QC_FAILED', qc_notes = 'IMEI mismatch' WHERE id = $1`, [l.id])
    expect((await alertsOf('QC_FAILED', m))[0].body).toBe('IMEI mismatch')
    await q(`UPDATE shop_products SET low_stock_threshold = 2, stock_quantity = 5 WHERE id = $1`, [l.id])
    const m2 = await mark()
    await q(`UPDATE shop_products SET stock_quantity = 3 WHERE id = $1`, [l.id])   // still above threshold
    await q(`UPDATE shop_products SET stock_quantity = 2 WHERE id = $1`, [l.id])   // crosses → alert
    await q(`UPDATE shop_products SET stock_quantity = 1 WHERE id = $1`, [l.id])   // already low → no second alert
    const low = await alertsOf('LOW_STOCK', m2)
    expect(low.length).toBe(1)
    expect(low[0].title).toMatch(/^Low stock/)
    await q(`UPDATE shop_products SET stock_quantity = 5 WHERE id = $1`, [l.id])
    const m3 = await mark()
    await q(`UPDATE shop_products SET stock_quantity = 0 WHERE id = $1`, [l.id])
    expect((await alertsOf('LOW_STOCK', m3))[0].title).toMatch(/^Out of stock/)
  })

  it('people and reviews: new vendor, new customer, review severity follows the rating', async () => {
    const m = await mark()
    await q(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Fresh Seller',$1,$2,$3)`, ['fs-' + rand(), `f${rand()}@t.io`, '72' + rand()])
    await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Fresh Customer','CUSTOMER')`, ['6' + rand()])
    await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Fresh Staff','ADMIN')`, ['6' + rand()])
    expect((await alertsOf('NEW_VENDOR', m))[0].title).toContain('Fresh Seller')
    expect((await alertsOf('NEW_CUSTOMER', m)).length).toBe(1)                  // staff accounts are not customers
    const l = await mkListing()
    await q(`INSERT INTO reviews (user_id, product_id, rating, comment) VALUES ($1,$2,5,'Great')`, [F.customer, l.product_id])
    await q(`INSERT INTO reviews (user_id, product_id, rating, comment) VALUES ($1,$2,1,'Broken')`, [F.admin2.id, l.product_id])
    const rv = await alertsOf('NEW_REVIEW', m)
    expect(rv.map((r) => r.severity)).toEqual(['INFO', 'WARNING'])
  })

  it('wallets: customer credits respect the minimum amount; vendor entries only for admin actions', async () => {
    const m = await mark()
    const w = (await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance RETURNING id`, [F.customer])).rows[0]
    const tx = (type, amt) => q(`INSERT INTO wallet_transactions (wallet_id, type, amount, description, balance_after) VALUES ($1,$2,$3,'test',0)`, [w.id, type, amt])
    await tx('CREDIT', 100)   // below ₹500 → silent
    await tx('CREDIT', 900)
    await tx('DEBIT', 650)
    expect((await alertsOf('WALLET_CREDIT', m)).map((a) => a.title)).toEqual(['Customer wallet credited ₹900'])
    expect((await alertsOf('WALLET_DEBIT', m)).length).toBe(1)
    const m2 = await mark()
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, idempotency_key) VALUES ($1,'GROSS_SALES',5000,5000,$2)`, [F.vendor.id, 'al:' + rand()])   // order posting → silent
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason_code, reference_type, idempotency_key) VALUES ($1,'BONUS',2000,7000,'BONUS','ADMIN_MANUAL',$2)`, [F.vendor.id, 'al:' + rand()])
    const v = await alertsOf('WALLET_CREDIT', m2)
    expect(v.length).toBe(1)
    expect(v[0].title).toBe('Vendor wallet credited ₹2,000')
  })

  it('Notification Control: switching a type off silences it; severity is overridable', async () => {
    await svc.updateSettings([{ type: 'NEW_CUSTOMER', enabled: false }, { type: 'NEW_VENDOR', severity: 'CRITICAL' }])
    const m = await mark()
    await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Silent Customer','CUSTOMER')`, ['6' + rand()])
    await q(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Loud Vendor',$1,$2,$3)`, ['lv-' + rand(), `l${rand()}@t.io`, '73' + rand()])
    expect((await alertsOf('NEW_CUSTOMER', m)).length).toBe(0)
    expect((await alertsOf('NEW_VENDOR', m))[0].severity).toBe('CRITICAL')
    await svc.updateSettings([{ type: 'NEW_CUSTOMER', enabled: true }, { type: 'NEW_VENDOR', severity: 'INFO' }, { type: 'WALLET_CREDIT', minAmount: 1000 }])
    expect((await svc.settings()).find((s) => s.type === 'WALLET_CREDIT').min_amount).toBe(1000)
    await svc.updateSettings([{ type: 'WALLET_CREDIT', minAmount: 500 }])
    await expect(svc.updateSettings([{ type: 'NOPE', enabled: true }])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updateSettings([{ type: 'RTO', severity: 'LOUD' }])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updateSettings([{ type: 'RTO', minAmount: -5 }])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updateSettings([])).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('read state is per admin: unread counts, mark read, mark all, filters', async () => {
    const m = await mark()
    await mkOrder(); await mkOrder()
    const feed = await svc.list(F.admin.id, { type: 'NEW_ORDER', unread: true })
    const mine = feed.data.filter((a) => a.id > m)
    expect(mine.length).toBe(2)
    expect(mine.every((a) => a.is_read === false && a.type_label === 'New order' && a.grp === 'Orders & payments')).toBe(true)
    const before = (await svc.unreadCount(F.admin.id)).total
    await svc.markRead(F.admin.id, [mine[0].id])
    expect((await svc.unreadCount(F.admin.id)).total).toBe(before - 1)
    expect((await svc.unreadCount(F.admin2.id)).total).toBe(before)           // the other admin is unaffected
    const after = await svc.list(F.admin.id, { type: 'NEW_ORDER' })
    expect(after.data.find((a) => a.id === mine[0].id).is_read).toBe(true)
    await svc.markAllRead(F.admin.id, { type: 'NEW_ORDER' })
    expect((await svc.list(F.admin.id, { type: 'NEW_ORDER', unread: true })).meta.total).toBe(0)
    expect((await svc.list(F.admin2.id, { type: 'NEW_ORDER', unread: true })).meta.total).toBeGreaterThan(0)
    expect((await svc.list(F.admin.id, { severity: 'CRITICAL' })).data.every((a) => a.severity === 'CRITICAL')).toBe(true)
    expect((await svc.list(F.admin.id, { group: 'Orders & payments' })).data.every((a) => a.grp === 'Orders & payments')).toBe(true)
    await expect(svc.markRead(F.admin.id, [])).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await svc.summary()).length).toBeGreaterThan(0)
  })

  it('a failing alert never blocks the original write', async () => {
    const { getClient } = await import('../../src/config/database.js')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE admin_alerts RENAME TO admin_alerts_gone')   // the alert insert now errors inside the trigger
      const { rows } = await client.query(
        `INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, payment_method, payment_status, delivery_address)
         VALUES ($1,$2,TRUE,'ORDER_PLACED','[]'::jsonb,10,10,'COD','PENDING','{}'::jsonb) RETURNING id`, ['AL-' + rand(), F.customer])
      expect(rows[0].id).toBeTruthy()                                              // …but the order still went through
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect((await q(`SELECT to_regclass('admin_alerts') AS t`)).rows[0].t).toBe('admin_alerts')
  })
})
