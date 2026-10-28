/**
 * B2B marketplace shelf — categories tree, category + deals filters (HTTP layer + real Postgres).
 *
 *   WS_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=ws_scratch DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   npx vitest run tests/integration/wholesale-market.integration.test.js
 * The target database must already be fully migrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'

const d = process.env.WS_TEST_DB ? describe : describe.skip

d('wholesale shelf: categories and deals (real database)', () => {
  let app, q, listings
  const V = {}
  const C = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const tag = `wsm${rand()}`
  const hdr = (v) => ({ authorization: `Bearer ${v.token}` })
  const get = async (v, url) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/vendor/b2b${url}`, headers: hdr(v) })
    return { status: res.statusCode, body: res.json() }
  }
  const mkVendor = async (name) => {
    const n = rand()
    const { rows } = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [name, `w-${n}`, `w${n}@t.io`, `7${n}`])
    const u = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id, session_version`, [`9${rand()}`, `${name} user`])).rows[0]
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [rows[0].id, u.id])
    await q(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ($1,$2,$3,'12 MG Road','Delhi','Delhi','110001',28.6,77.2,$4,5,true)`, [`${name} Shop`, `ws-${n}`, `W${n.slice(0, 6)}`, rows[0].id])
    return { id: rows[0].id, userId: u.id, name, token: jwt.sign({ id: u.id, role: 'CUSTOMER', session_version: u.session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkCat = async (name, parentId = null) =>
    (await q(`INSERT INTO categories (name, slug, parent_id) VALUES ($1,$2,$3) RETURNING id`, [name, `${tag}-${name.toLowerCase().replace(/\W+/g, '-')}`, parentId])).rows[0].id
  const mkListing = async (v, categoryId, name, over = {}) => {
    const l = await listings.create({
      name: `${tag} ${name}`, brand: tag, categoryId, condition: 'NEW', stock: 20, specifications: { storage: '128GB' },
      images: ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg'], sellB2c: false, sellB2b: true, wholesalePrice: 30000, moq: 2, ...over,
    }, { vendorId: v.id, actorId: v.userId })
    await q(`UPDATE shop_products SET approval_status='APPROVED', listing_status='ACTIVE' WHERE id=$1`, [l.id])
    return l
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    V.buyer = await mkVendor('Shelf Buyer')
    V.seller = await mkVendor('Shelf Seller')
    // Smartphones › Flagship, Smartphones › Budget, Laptops (empty) — names carry a per-run marker.
    C.phones = await mkCat(`${tag} Smartphones`)
    C.flagship = await mkCat(`${tag} Flagship`, C.phones)
    C.budget = await mkCat(`${tag} Budget`, C.phones)
    C.laptops = await mkCat(`${tag} Laptops`)
    V.flagship = await mkListing(V.seller, C.flagship, 'Pro Max', { b2bDiscountPct: 18, wholesalePrice: 90000 })
    V.budget = await mkListing(V.seller, C.budget, 'Lite', { wholesalePrice: 9000 })
    V.own = await mkListing(V.buyer, C.budget, 'Buyer Own', { b2bDiscountPct: 30 })
  }, 90000)
  afterAll(async () => { await app?.close() })

  const node = (tree, id) => {
    for (const n of tree) {
      if (n.id === id) return n
      const hit = node(n.children, id)
      if (hit) return hit
    }
    return null
  }

  it('category tree lists only categories with buyable stock, rolled up into the parent', async () => {
    const { status, body } = await get(V.buyer, '/wholesale/categories')
    expect(status).toBe(200)
    const phones = node(body.data, C.phones)
    expect(phones.count).toBe(2)
    expect(phones.children.map((c) => c.id).sort()).toEqual([C.flagship, C.budget].sort())
    expect(node(body.data, C.flagship).count).toBe(1)
    expect(node(body.data, C.laptops)).toBeNull() // empty branch is hidden
  })

  it("the caller's own listings are never counted", async () => {
    const buyer = await get(V.buyer, '/wholesale/categories')
    const seller = await get(V.seller, '/wholesale/categories')
    expect(node(buyer.body.data, C.budget).count).toBe(1) // seller's Lite only
    expect(node(seller.body.data, C.budget).count).toBe(1) // buyer's own listing is the only one the seller can see
  })

  it('category filter takes in sub-categories', async () => {
    const parent = await get(V.buyer, `/wholesale?category=${C.phones}&limit=50`)
    expect(parent.body.data.map((r) => r.id).sort()).toEqual([V.flagship.id, V.budget.id].sort())
    const child = await get(V.buyer, `/wholesale?category=${C.flagship}`)
    expect(child.body.data.map((r) => r.id)).toEqual([V.flagship.id])
    expect(child.body.pagination.total).toBe(1)
    const none = await get(V.buyer, `/wholesale?category=${C.laptops}`)
    expect(none.body.data).toEqual([])
  })

  it('ignores a malformed category id instead of failing', async () => {
    const res = await get(V.buyer, '/wholesale?category=not-a-uuid&limit=1')
    expect(res.status).toBe(200)
  })

  it('deals=1 keeps only discounted listings and sort=discount puts the biggest first', async () => {
    const deals = await get(V.buyer, `/wholesale?category=${C.phones}&deals=1`)
    expect(deals.body.data.map((r) => r.id)).toEqual([V.flagship.id])
    expect(deals.body.data[0].discount_pct).toBe(18)
    const sorted = await get(V.seller, `/wholesale?category=${C.budget}&sort=discount`)
    expect(sorted.body.data[0].discount_pct).toBe(30)
  })

  it('brand facets stay scoped to the chosen category', async () => {
    const res = await get(V.buyer, `/wholesale?category=${C.flagship}`)
    expect(res.body.facets.brands).toEqual([{ value: tag, count: 1 }])
  })
})
