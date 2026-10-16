/**
 * Cart → Dealker Points: GET /cart/points preview, and an order that spends points (clamped by the server).
 *   CART_TEST_DB=1 DB_HOST=… DB_PORT=… DB_NAME=… DB_USER=… DB_PASSWORD=… REDIS_PORT=… \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… ALLOW_ALL_PINCODES=true \
 *   npx vitest run tests/integration/cart-points.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'

const d = process.env.CART_TEST_DB ? describe : describe.skip

d('cart points', () => {
  let app, q
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const call = async (method, url, payload) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${T.token}` }, payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data }
  }

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    const u = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Points Tester','CUSTOMER') RETURNING id, session_version`, ['8' + rand()])
    T.id = u.id
    T.token = jwt.sign({ id: u.id, role: 'CUSTOMER', session_version: u.session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' })
    const vendor = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Pts Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['pv-' + rand(), `p${rand()}@t.io`, '6' + rand()])
    const shop = await one(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ('Pts Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['ps-' + rand(), 'P' + rand().slice(0, 6), vendor.id])
    const p = await one(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('Points Phone',$1,10000,'VENDOR',$2,true) RETURNING id`, ['pp-' + rand(), vendor.id])
    await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,10000,10,true)`, [shop.id, p.id])
    T.productId = p.id; T.shopId = shop.id
    const a = await one(`INSERT INTO addresses (user_id, address_line1, address_line2, city, state, pincode, lat, lng, is_default) VALUES ($1,'1 Road','Flat 2','Kolkata','West Bengal','700001',22.5,88.3,true) RETURNING id`, [T.id])
    T.addressId = a.id
    await q(`UPDATE loyalty_settings SET enabled = TRUE, points_per_rupee = 0.02, point_value = 1, min_redeemable_points = 50, max_redemption_pct = 20, max_points_per_order = NULL, min_order_amount_to_earn = 0 WHERE id = TRUE`)
    const { LoyaltyService } = await import('../../src/modules/loyalty/loyalty.service.js')
    await new LoyaltyService().adminAdjust(T.id, 450, 'test credit', null)
    await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [T.id])
    expect((await call('POST', '/api/v1/cart/items', { productId: T.productId, shopId: T.shopId, quantity: 1 })).status).toBe(200)
  }, 90000)
  afterAll(async () => { await app?.close() })

  it('previews balance, the 20 % cap and the earn estimate', async () => {
    const r = await call('GET', '/api/v1/cart/points')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.data).toMatchObject({ enabled: true, balance: 450, pointValue: 1, minRedeemable: 50, maxRedemptionPct: 20, maxPoints: 450, earnEstimate: 200 })
  })
  it('a coupon discount shrinks what points may cover', async () => {
    const r = await call('GET', '/api/v1/cart/points?couponDiscount=9000')
    expect(r.data.maxPoints).toBe(200) // 20 % of (10000 − 9000)
    expect(r.data.earnEstimate).toBe(20)
  })
  it('turns redemption off when the balance is below the minimum', async () => {
    await q(`UPDATE loyalty_settings SET min_redeemable_points = 500 WHERE id = TRUE`)
    const r = await call('GET', '/api/v1/cart/points')
    expect(r.data.maxPoints).toBe(0)
    await q(`UPDATE loyalty_settings SET min_redeemable_points = 50 WHERE id = TRUE`)
  })
  it('an order accepts loyaltyPointsToRedeem, clamps it, and debits the points', async () => {
    const r = await call('POST', '/api/v1/orders', { addressId: T.addressId, paymentMethod: 'COD', loyaltyPointsToRedeem: 9999 })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const bal = await one(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [T.id])
    // cap is 20 % of ₹10,000 = 2,000 points but the balance is 450: spends everything it has
    expect(Number(bal.points_balance)).toBe(0)
    const o = await one(`SELECT loyalty_redeemed_amount FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`, [T.id])
    expect(Number(o.loyalty_redeemed_amount)).toBe(450)
  })
})
