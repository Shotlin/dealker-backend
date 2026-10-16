/**
 * Auctions browse page API: counts, filters, sort, brand facets, watching, my bids, "Notify me" preference.
 *   AUCTION_TEST_DB=1 DB_HOST=… DB_PORT=… DB_NAME=… DB_USER=… DB_PASSWORD=… REDIS_PORT=… npx vitest run tests/integration/auction-browse.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.AUCTION_TEST_DB ? describe : describe.skip

d('auction browse (real database)', () => {
  const U = {}
  let q, pool, bid, admin
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')

  const product = async (name, brand, price) => {
    const { rows: [p] } = await q(`INSERT INTO products (name, slug, price, brand, owner_type, is_active) VALUES ($1,$2,$3,$4,'ADMIN',true) RETURNING id`, [name, 'bp-' + rand(), price, brand])
    await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,$3,1,true)`, [U.shop, p.id, price])
    return p.id
  }
  const make = async (name, brand, price, { startsInMs = -1000 } = {}) => {
    const productId = await product(name, brand, price)
    return admin.createAuction(U.actor, { productId, startPrice: price, registrationFee: 500, bidIncrement: 500, startsAt: new Date(Date.now() + startsInMs).toISOString(), durationHours: 3 })
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query; pool = db.pool
    bid = await import('../../src/modules/auctions/auction-bidding.service.js')
    admin = await import('../../src/modules/auctions/auction-admin.service.js')
    const shared = await import('../../src/modules/auctions/auction.shared.js')
    const one = async (sql, p) => (await q(sql, p)).rows[0]
    U.adminUser = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Admin','ADMIN') RETURNING id`, ['9' + rand()])
    U.actor = { kind: 'ADMIN', userId: U.adminUser.id, vendorId: null }
    U.shop = (await one(`SELECT id FROM shops WHERE is_platform = true LIMIT 1`)).id
    U.me = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Me','CUSTOMER') RETURNING id`, ['8' + rand()])).id
    await q(`INSERT INTO addresses (user_id, address_line1, city, state, pincode, is_default) VALUES ($1,'1 Road','Kolkata','West Bengal','700001',true)`, [U.me])
    await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 50000) ON CONFLICT (user_id) DO UPDATE SET balance = 50000`, [U.me])
    await q('DELETE FROM auctions')
    await q(`UPDATE auction_settings SET enabled = TRUE, vendor_auctions_require_approval = FALSE, bid_rate_limit_per_minute = 1000 WHERE id = TRUE`)
    shared.invalidateSettingsCache()
    U.a1 = await make('Apple iPhone 13 test', 'Apple', 30000)
    U.a2 = await make('Samsung S22 test', 'Samsung', 27000)
    U.a3 = await make('Apple MacBook test', 'Apple', 52000)
    U.up = await make('OnePlus 11R test', 'OnePlus', 18000, { startsInMs: 2 * 3600_000 })
  })
  afterAll(async () => { await pool?.end().catch(() => {}) })

  it('returns tab counts, brand facets and the chosen sort in one call', async () => {
    const r = await bid.listPublic(U.me, { tab: 'live' })
    expect(r.counts).toMatchObject({ live: 3, upcoming: 1, ended: 0, watching: 0 })
    expect(r.facets.brands.find((b) => b.name === 'Apple').count).toBe(2)
    expect(r.pagination.total).toBe(3)
    const asc = await bid.listPublic(U.me, { tab: 'live', sort: 'price_asc' })
    expect(asc.data.map((x) => x.current_price)).toEqual([27000, 30000, 52000])
    const desc = await bid.listPublic(U.me, { tab: 'live', sort: 'price_desc' })
    expect(desc.data[0].current_price).toBe(52000)
  })
  it('filters by brand and price, and facets ignore those filters', async () => {
    const apple = await bid.listPublic(U.me, { tab: 'live', brand: 'apple' })
    expect(apple.data).toHaveLength(2)
    expect(apple.facets.brands.map((b) => b.name).sort()).toEqual(['Apple', 'Samsung'])
    const cheap = await bid.listPublic(U.me, { tab: 'live', max: 28000 })
    expect(cheap.data.map((x) => x.title)).toEqual(['Samsung S22 test'])
    const mid = await bid.listPublic(U.me, { tab: 'live', min: 29000, max: 40000 })
    expect(mid.data).toHaveLength(1)
  })
  it('registration=open hides auctions the user already joined', async () => {
    await bid.register(U.me, U.a1.id, { consent: true, ip: '10.0.0.1' })
    const open = await bid.listPublic(U.me, { tab: 'live', registration: 'open' })
    expect(open.data.map((x) => x.id)).not.toContain(U.a1.id)
    expect(open.data).toHaveLength(2)
  })
  it('watching list + count, and remind-me on an upcoming auction', async () => {
    await bid.watch(U.me, U.up.id)
    const w = await bid.listWatching(U.me)
    // joining an auction (a1) also watches it
    expect(w.data.map((x) => x.id).sort()).toEqual([U.a1.id, U.up.id].sort())
    const r = await bid.listPublic(U.me, { tab: 'upcoming' })
    expect(r.counts.watching).toBe(2)
    expect(r.data[0].watching).toBe(true)
  })
  it('my bids "all" returns joined auctions in any state', async () => {
    const m = await bid.mine(U.me, { tab: 'all' })
    expect(m.data.map((x) => x.id)).toEqual([U.a1.id])
    expect(m.data[0].my.registered).toBe(true)
  })
  it('"Notify me" preference is saved without wiping other preferences', async () => {
    const { NotificationsRepository } = await import('../../src/modules/notifications/notifications.repository.js')
    const repo = new NotificationsRepository()
    await repo.updatePreferences(U.me, { promotions: false })
    await repo.updatePreferences(U.me, { auctionAlerts: true })
    const p = await repo.getPreferences(U.me)
    expect(p.auctionAlerts).toBe(true)
    expect(p.promotions).toBe(false)
  })
})
