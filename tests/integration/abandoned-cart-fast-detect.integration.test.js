/**
 * Abandoned carts show up within ~5 s of a customer adding to the cart — REAL Postgres + Redis.
 *
 *   ACF_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=<migrated scratch db> DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   npx vitest run tests/integration/abandoned-cart-fast-detect.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.ACF_TEST_DB ? describe : describe.skip
const WITHIN_MS = 5000

d('fast abandoned-cart detection (real database)', () => {
  let q, pool, redis, cartRepo, vendorSvc, adminRepo, worker
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let vendor, shop, product, userId

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    delete process.env.ABANDONED_CART_THRESHOLD_MINUTES // use the shipped default
    const db = await import('../../src/config/database.js')
    q = db.query
    pool = db.pool
    redis = (await import('../../src/config/redis.js')).redis
    cartRepo = new (await import('../../src/modules/cart/cart.repository.js')).CartRepository()
    vendorSvc = await import('../../src/modules/vendor-abandoned-carts/vendor-abandoned-carts.service.js')
    const { AdminAbandonedCartsRepository } = await import('../../src/modules/admin/abandoned-carts/abandoned-carts.repository.js')
    adminRepo = new AdminAbandonedCartsRepository()
    worker = await import('../../src/workers/abandoned-cart.worker.js')

    vendor = await one(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Fast Vendor',$1,$2,$3) RETURNING id`, [`fv-${rand()}`, `fv${rand()}@t.io`, '6' + rand()])
    shop = await one(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ('Fast Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`,
      [`fs-${rand()}`, 'F' + rand().slice(0, 6), vendor.id])
    product = await one(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('Fast Phone X',$1,25000,'VENDOR',$2,true) RETURNING id`, [`fp-${rand()}`, vendor.id])
    await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,25000,20,true)`, [shop.id, product.id])
    userId = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Asha Verma','CUSTOMER') RETURNING id`, ['8' + rand()])).id
    await q(`INSERT INTO user_shop_allocations (user_id, shop_id, is_primary) VALUES ($1,$2,true)`, [userId, shop.id])
    worker.startAbandonedCartWorker()
  })

  afterAll(async () => {
    worker?.stopAbandonedCartWorker()
    await redis?.quit().catch(() => {})
    await pool?.end().catch(() => {})
  })

  const addToCart = () => cartRepo.saveCart(userId, [{ productId: product.id, shopId: shop.id, quantity: 1 }], 'retail')
  const waitForVendorRow = async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      const { data } = await vendorSvc.list(vendor.id, { channel: 'ALL' })
      const row = data.find((r) => r.state === 'ABANDONED')
      if (row) return { row, ms: Date.now() - t0 }
      await sleep(250)
    }
    return { row: null, ms: Date.now() - t0 }
  }

  it('shows the cart to the vendor within 5 s, with the product', async () => {
    await addToCart()
    const { row, ms } = await waitForVendorRow()
    console.log(`vendor saw the cart after ${ms} ms`)
    expect(row).toBeTruthy()
    expect(ms).toBeLessThanOrEqual(WITHIN_MS)
    expect(row.top_product).toBe('Fast Phone X')
    expect(row.customer).toBeTruthy()
  })

  it('shows the same cart to the admin with the customer and the product', async () => {
    const list = await adminRepo.findAll({ offset: 0, limit: 50, status: 'OPEN' })
    const row = list.carts.find((c) => c.userId === userId)
    expect(row).toBeTruthy()
    expect(row.userName).toBe('Asha Verma')
    expect(row.topProducts.map((p) => p.name)).toContain('Fast Phone X')
    expect(row.vendorNames).toContain('Fast Vendor')
  })

  it('re-adding (recovered) then idling again re-opens the SAME episode instead of stacking rows', async () => {
    const before = await one(`SELECT id FROM abandoned_carts WHERE user_id = $1`, [userId])
    const { AbandonedCartsRepository } = await import('../../src/modules/abandoned-carts/abandoned-carts.repository.js')
    await new AbandonedCartsRepository().markRecoveredByUserId(userId, 'retail')
    await addToCart()
    const t0 = Date.now()
    let open = null
    while (Date.now() - t0 < 15000 && !open) {
      open = await one(`SELECT id FROM abandoned_carts WHERE user_id = $1 AND status = 'OPEN'`, [userId])
      if (!open) await sleep(250)
    }
    console.log(`re-opened after ${Date.now() - t0} ms`)
    expect(open?.id).toBe(before.id)
    expect(Date.now() - t0).toBeLessThanOrEqual(WITHIN_MS)
    const count = await one(`SELECT COUNT(*)::int AS n FROM abandoned_carts WHERE user_id = $1`, [userId])
    expect(count.n).toBe(1)
  })
})
