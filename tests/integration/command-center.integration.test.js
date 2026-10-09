/**
 * Command centre — real Postgres. Fixtures are added and every widget is
 * checked as a before/after delta, so the test works on a database that
 * already holds data.
 *
 *   CC_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/command-center.integration.test.js
 */
import { beforeAll, describe, expect, it } from 'vitest'

const d = process.env.CC_TEST_DB ? describe : describe.skip

d('command centre (real database)', () => {
  let q, cc
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const delta = (a, b, pick) => Math.round((pick(b) - pick(a)) * 100) / 100

  const mkOrder = async (o = {}) => (await q(
    `INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, wallet_amount, payment_method, payment_status, payment_plan, amount_due, delivery_address)
     VALUES ($1,$2,TRUE,$3,'[]'::jsonb,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb) RETURNING id`,
    ['CC-' + rand(), o.customer ?? F.customer, o.status ?? 'DELIVERED', o.billed ?? 1000, o.payable ?? o.billed ?? 1000, o.wallet ?? 0,
      o.method ?? 'ONLINE', o.pay ?? 'PAID', o.plan ?? 'FULL_ONLINE', o.due ?? 0])).rows[0]

  /** A requirement plus the quote every B2B order has to point at. */
  const mkRequirement = async (title) => {
    const req = (await q(`INSERT INTO b2b_requirements (requirement_number, buyer_vendor_id, posted_by_type, title, product_name, quantity_needed, status, response_deadline)
                          VALUES ($1,$2,'VENDOR',$3,'Item',10,'AWARDED', NOW() + interval '5 days') RETURNING id`, ['REQ-' + rand(), F.vendor2.id, title])).rows[0]
    const quote = (await q(`INSERT INTO b2b_quotes (requirement_id, seller_vendor_id, quantity_offered, unit_price) VALUES ($1,$2,10,1000) RETURNING id`, [req.id, F.vendor.id])).rows[0]
    return { req, quote }
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    const { CommandCenterService } = await import('../../src/modules/command-center/command-center.service.js')
    cc = new CommandCenterService()
    F.vendor = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('CC Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['ccv-' + rand(), `c${rand()}@t.io`, '78' + rand()])).rows[0]
    F.vendor2 = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('CC Buyer Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['ccb-' + rand(), `b${rand()}@t.io`, '79' + rand()])).rows[0]
    F.customer = (await q(`INSERT INTO users (phone, name, role, last_active_at) VALUES ($1,'CC Buyer','CUSTOMER', NOW()) RETURNING id`, ['7' + rand()])).rows[0].id
  })

  it('rejects nothing for valid periods and returns every widget group', async () => {
    const x = await cc.build('month')
    for (const k of ['sales', 'orders', 'refunds', 'exchanges', 'payments', 'wallets', 'money', 'users', 'abandoned', 'sellOnPhone', 'auctions', 'campaigns', 'subscriptions', 'alerts']) {
      expect(x, k).toHaveProperty(k)
    }
    expect(x.users.topBuyers.length).toBeLessThanOrEqual(5)
  })

  it('B2C sales count billed value (total + wallet) and skip cancelled, refunded and unpaid online orders', async () => {
    const a = await cc.build('today')
    await mkOrder({ billed: 1000 })                                                       // counts 1000
    await mkOrder({ billed: 500, payable: 300, wallet: 200 })                             // billed 500 (wallet part included)
    await mkOrder({ billed: 9999, status: 'CANCELLED' })                                  // ignored
    await mkOrder({ billed: 8888, status: 'REFUNDED' })                                   // ignored
    await mkOrder({ billed: 7777, status: 'ORDER_PLACED', pay: 'PENDING' })               // unpaid online → ignored for sales
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.sales.b2c.value)).toBe(1500)
    expect(delta(a, b, (x) => x.sales.total.value)).toBe(1500)
    expect(delta(a, b, (x) => x.orders.total.value)).toBe(5)
    expect(delta(a, b, (x) => x.orders.delivered.value)).toBe(2)
    expect(delta(a, b, (x) => x.orders.cancelled.value)).toBe(1)
    expect(delta(a, b, (x) => x.orders.pending.value)).toBe(1)           // global pending now
  })

  it('COD and partial-payment orders are reported with their value', async () => {
    const a = await cc.build('today')
    await mkOrder({ billed: 2000, method: 'COD', pay: 'PENDING', plan: 'COD', due: 2000, status: 'CONFIRMED' })
    await mkOrder({ billed: 50000, payable: 45000, wallet: 5000, method: 'ONLINE', pay: 'PARTIALLY_PAID', plan: 'PARTIAL', due: 45000, status: 'CONFIRMED' })
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.payments.codOrders)).toBe(1)
    expect(delta(a, b, (x) => x.payments.partialOrders)).toBe(1)
    expect(delta(a, b, (x) => x.payments.codValue)).toBe(52000)
  })

  it('B2B sales only count money held in escrow or released', async () => {
    const { req, quote } = await mkRequirement('Bulk phones')
    const a = await cc.build('today')
    const ins = (sub, status, pay, comm) => q(
      `INSERT INTO b2b_orders (order_number, requirement_id, quote_id, buyer_vendor_id, seller_vendor_id, quantity, unit_price, subtotal, commission_amount, seller_payable, status, payment_status)
       VALUES ($1,$2,$3,$4,$5,1,$6,$6,$7,$8,$9,$10)`, ['B2B-' + rand(), req.id, quote.id, F.vendor2.id, F.vendor.id, sub, comm, sub - comm, status, pay])
    await ins(40000, 'PAID', 'ESCROW_HELD', 4000)       // counts
    await ins(10000, 'COMPLETED', 'RELEASED', 1000)     // counts
    await ins(70000, 'PENDING_PAYMENT', 'UNPAID', 7000) // not paid
    await ins(30000, 'CANCELLED', 'REFUNDED', 3000)     // cancelled
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.sales.b2b.value)).toBe(50000)
    expect(delta(a, b, (x) => x.orders.b2bOrders.value)).toBe(4)
    expect(delta(a, b, (x) => x.money.vendorCommission.value)).toBe(5000)
    expect(delta(a, b, (x) => x.sales.total.value)).toBe(50000)
  })

  it('commission, platform charges and tax come from seller orders (cancelled ones excluded)', async () => {
    const a = await cc.build('today')
    const o1 = await mkOrder(); const o2 = await mkOrder()
    const so = (o, status, sub, comm, pc, ft, tax) => q(
      `INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, status, item_subtotal, commission_amount, platform_charge, fee_tax_amount, tax_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [o.id, 'SO-' + rand(), F.vendor.id, status, sub, comm, pc, ft, tax])
    await so(o1, 'DELIVERED', 1000, 50, 10, 10.8, 120)
    await so(o2, 'CANCELLED', 5000, 500, 100, 108, 600)
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.money.vendorCommission.value)).toBe(50)
    expect(delta(a, b, (x) => x.money.platformCharges.value)).toBe(10)
    expect(delta(a, b, (x) => x.money.tax.total)).toBe(130.8)
    expect(delta(a, b, (x) => x.money.vendorGross)).toBe(1000)
    const tv = (await cc.build('today')).users.topVendors.find((v) => v.id === F.vendor.id)
    expect(tv.sales).toBeGreaterThanOrEqual(1000)
  })

  it('refunds, exchanges and sell-on-phone leads are counted per kind', async () => {
    const a = await cc.build('today')
    const o = await mkOrder(); const o2 = await mkOrder()
    await q(`INSERT INTO refund_requests (order_id, customer_id, scope, reason, refund_destination, computed_amount, resolved_amount, status)
             VALUES ($1,$2,'FULL_ORDER','Damaged','WALLET',700,650,'APPROVED')`, [o.id, F.customer])
    await q(`INSERT INTO refund_requests (order_id, customer_id, scope, reason, refund_destination, computed_amount, status)
             VALUES ($1,$2,'FULL_ORDER','Not needed','WALLET',300,'PENDING')`, [o2.id, F.customer])
    const sell = (kind, status, price) => q(
      `INSERT INTO sell_requests (code, type, status, user_id, customer_name, customer_phone, model_name, variant, color, category, imei, qa, condition, base_price, quote, expected_price, final_price, exchange)
       VALUES ($1,$2,$3,$4,'Cust','9000000000','Pixel','128','Black','Smartphone',$5,'{}'::jsonb,'GOOD',1000,1000,1000,$6,$7)`,
      [`${kind === 'SELL' ? 'SELL' : 'EXCH'}-${rand()}`, kind === 'SELL' ? 'SELL_TO_AB' : 'EXCHANGE', status, F.customer, rand() + '123456', price,
        kind === 'SELL' ? null : JSON.stringify({ newProduct: 'iPhone 15' })])
    await sell('SELL', 'COMPLETED', 800); await sell('SELL', 'PENDING', null)
    await sell('EXCHANGE', 'COMPLETED', 500)
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.refunds.value)).toBe(2)
    expect(delta(a, b, (x) => x.refunds.amount)).toBe(650)        // pending refunds are not money out yet
    expect(delta(a, b, (x) => x.sellOnPhone.value)).toBe(2)
    expect(delta(a, b, (x) => x.sellOnPhone.completed)).toBe(1)
    expect(delta(a, b, (x) => x.sellOnPhone.payoutValue)).toBe(800)
    expect(delta(a, b, (x) => x.exchanges.value)).toBe(1)
  })

  it('wallets: customer balance, vendor ledger balance and holds', async () => {
    const a = await cc.build('today')
    const w = (await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 250) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + 250 RETURNING id`, [F.customer])).rows[0]
    await q(`INSERT INTO wallet_transactions (wallet_id, type, amount, description, balance_after) VALUES ($1,'CREDIT',250,'test',250)`, [w.id])
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, idempotency_key) VALUES ($1,'GROSS_SALES',1000,1000,$2),($1,'COMMISSION',-100,900,$3)`, [F.vendor.id, 'cc:' + rand(), 'cc:' + rand()])
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.wallets.customer.balance)).toBe(250)
    expect(delta(a, b, (x) => x.wallets.customer.credits)).toBe(250)
    expect(delta(a, b, (x) => x.wallets.vendor.balance)).toBe(900)
    expect(delta(a, b, (x) => x.wallets.vendor.credits)).toBe(1000)
    expect(delta(a, b, (x) => x.wallets.vendor.debits)).toBe(100)
  })

  it('users: new customers/vendors, retained buyers, live users', async () => {
    const a = await cc.build('today')
    await q(`INSERT INTO users (phone, name, role) VALUES ($1,'New Cust','CUSTOMER')`, ['6' + rand()])
    await q(`INSERT INTO vendors (name, slug, email, phone) VALUES ('New V',$1,$2,$3)`, ['nv-' + rand(), `n${rand()}@t.io`, '70' + rand()])
    // a customer with an older order who orders again today = retained
    const old = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Loyal','CUSTOMER') RETURNING id`, ['5' + rand()])).rows[0].id
    const prior = await mkOrder({ customer: old })
    await q(`UPDATE orders SET created_at = NOW() - interval '10 days' WHERE id = $1`, [prior.id])
    await mkOrder({ customer: old })
    const b = await cc.build('week')
    const a2 = a // today-based for new users
    const bToday = await cc.build('today')
    expect(delta(a2, bToday, (x) => x.users.newCustomers.value)).toBeGreaterThanOrEqual(2)
    expect(delta(a2, bToday, (x) => x.users.newVendors.value)).toBe(1)
    expect(b.users.retained.returningBuyers).toBeGreaterThanOrEqual(1)
    expect(b.users.retained.rate).toBeGreaterThan(0)
    expect(bToday.users.live.customers).toBeGreaterThanOrEqual(1)
    expect(b.users.topBuyers[0].spent).toBeGreaterThan(0)
  })

  it('abandoned carts: B2C open carts and B2B checkouts unpaid for 24 h+', async () => {
    const a = await cc.build('today')
    await q(`INSERT INTO abandoned_carts (user_id, status, abandoned_at, item_count, total_quantity, cart_value) VALUES ($1,'OPEN',NOW(),2,2,4000)`, [F.customer])
    const { req, quote } = await mkRequirement('Stale')
    const ins = (hours) => q(
      `INSERT INTO b2b_orders (order_number, requirement_id, quote_id, buyer_vendor_id, seller_vendor_id, quantity, unit_price, subtotal, status, payment_status, created_at)
       VALUES ($1,$2,$3,$4,$5,1,12000,12000,'PENDING_PAYMENT','UNPAID', NOW() - ($6 || ' hours')::interval)`, ['B2B-' + rand(), req.id, quote.id, F.vendor2.id, F.vendor.id, String(hours)])
    await ins(30); await ins(2)  // only the 30 h one is abandoned
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.abandoned.b2c.open)).toBe(1)
    expect(delta(a, b, (x) => x.abandoned.b2c.openValue)).toBe(4000)
    expect(delta(a, b, (x) => x.abandoned.b2b.count)).toBe(1)
    expect(delta(a, b, (x) => x.abandoned.b2b.value)).toBe(12000)
  })

  it('alerts summary and feed come from admin_alerts', async () => {
    const { emitAlert } = await import('../../src/modules/alerts/alerts.service.js')
    const a = await cc.build('today')
    await emitAlert({ type: 'LOW_STOCK', severity: 'CRITICAL', title: 'CC critical alert', dedupeKey: 'cc-' + rand() })
    await emitAlert({ type: 'NEW_REVIEW', severity: 'INFO', title: 'CC info alert', dedupeKey: 'cc-' + rand() })
    const b = await cc.build('today')
    expect(delta(a, b, (x) => x.alerts.summary.critical)).toBe(1)
    expect(delta(a, b, (x) => x.alerts.summary.info)).toBe(1)
    expect(b.alerts.recent.length).toBeGreaterThan(0)
    expect(b.alerts.recent.length).toBeLessThanOrEqual(8)
  })

  it('trend: change % compares with the previous equal-length period', async () => {
    const x = await cc.build('week')
    expect(x.sales.total).toHaveProperty('previous')
    expect(typeof x.sales.total.change).toBe('number')
  })
})
