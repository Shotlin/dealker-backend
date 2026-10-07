/**
 * Sponsored ads — integration tests against a REAL Postgres.
 *
 * Opt-in (never runs against a dev database by accident):
 *   ADS_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=dealker_ads_test DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/ads.integration.test.js
 * The target database must already be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const enabled = !!process.env.ADS_TEST_DB
const d = enabled ? describe : describe.skip

let q, pool, S

d('sponsored ads (real database)', () => {
  const U = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
    })
    const db = await import('../../src/config/database.js')
    q = db.query
    pool = db.pool
    S = {
      shared: await import('../../src/modules/ads/ads.shared.js'),
      manage: await import('../../src/modules/ads/ads-manage.service.js'),
      billing: await import('../../src/modules/ads/ads-billing.service.js'),
      serve: await import('../../src/modules/ads/ads-serving.service.js'),
    }
    U.adminUser = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Admin','ADMIN') RETURNING id`, ['9' + rand()])
    U.admin = { kind: 'ADMIN', userId: U.adminUser.id, vendorId: null }
    for (const k of ['v1', 'v2', 'v3']) {
      U[k] = await one(`INSERT INTO vendors (name, slug, email, phone) VALUES ($1,$2,$3,$4) RETURNING id`, [`Vendor ${k}`, `${k}-${rand()}`, `${k}${rand()}@t.io`, '6' + rand()])
      U[k].actor = { kind: 'VENDOR', userId: null, vendorId: U[k].id }
      U[k].shop = await one(
        `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
         VALUES ($1,$2,$3,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$4,10,true) RETURNING id`,
        [`Shop ${k}`, `s-${k}-${rand()}`, 'T' + rand().slice(0, 6), U[k].id])
    }
    U.staff = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Staff','CUSTOMER') RETURNING id`, ['7' + rand()])).id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [U.v1.id, U.staff])
    U.shopper = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Shopper','CUSTOMER') RETURNING id`, ['8' + rand()])).id
    U.shopper2 = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Shopper2','CUSTOMER') RETURNING id`, ['8' + rand()])).id
  })

  afterAll(async () => { await pool?.end().catch(() => {}) })

  const product = async (vendor, name, price = 1000) => {
    const slug = `ad-${rand()}`
    const p = await one(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ($1,$2,$3,'VENDOR',$4,true) RETURNING id`, [name, slug, price, vendor.id])
    await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,$3,10,true)`, [vendor.shop.id, p.id, price])
    return p.id
  }
  const fund = (vendor, amount) => S.billing.adminCredit(vendor.id, U.admin, { amount, kind: 'TOPUP_ADMIN', reason: 'test funding' })
  const balance = async (vendor) => Number((await one(`SELECT COALESCE((SELECT balance FROM ad_wallets WHERE vendor_id = $1), 0) AS b`, [vendor.id])).b)

  /** Campaign that is ACTIVE and bidding on `keyword` for `productId`. */
  const liveCampaign = async (vendor, productId, { keyword = 'phone', bid = 10, daily = 500, matchType = 'BROAD', targeting = 'MANUAL', total } = {}) => {
    const c = await S.manage.createCampaign(U.admin, {
      vendorId: vendor.id, name: `Camp ${rand()}`, targeting, defaultBid: bid, dailyBudget: daily, totalBudget: total,
      productIds: [productId], keywords: targeting === 'MANUAL' ? [{ keyword, matchType }] : [],
    })
    return S.manage.submit(U.admin, c.id) // admin submit auto-activates
  }

  beforeEach(async () => {
    await q(`DELETE FROM ad_campaigns`)
    await q(`DELETE FROM ad_wallet_ledger`)
    await q(`DELETE FROM ad_wallets`)
    await q(`DELETE FROM settlement_ledger WHERE vendor_id IN ($1,$2,$3)`, [U.v1.id, U.v2.id, U.v3.id])
    await q(`UPDATE ad_settings SET enabled = TRUE, campaigns_require_approval = TRUE, min_cpc = 2, max_cpc = 500, min_daily_budget = 100,
             min_topup = 500, gst_pct = 18, slots_per_page = 4, max_ads_per_vendor_per_page = 2, min_quality_score = 0.25, click_dedupe_minutes = 30 WHERE id = TRUE`)
    S.shared.invalidateSettingsCache()
  })

  // ── campaign lifecycle ────────────────────────────────────────────────

  it('vendor campaigns need approval; admin approval activates; rejection needs a reason', async () => {
    const pid = await product(U.v1, 'Lifecycle Phone')
    const c = await S.manage.createCampaign(U.v1.actor, { name: 'My campaign', targeting: 'AUTO', defaultBid: 8, dailyBudget: 200, productIds: [pid] })
    expect(c.status).toBe('DRAFT')
    const sub = await S.manage.submit(U.v1.actor, c.id)
    expect(sub.status).toBe('PENDING_REVIEW')
    await expect(S.manage.reject(U.admin, c.id, '')).rejects.toMatchObject({ code: 'VALIDATION' })
    const approved = await S.manage.approve(U.admin, c.id)
    expect(approved.status).toBe('ACTIVE')
    expect((await S.manage.pause(U.v1.actor, c.id)).status).toBe('PAUSED')
    await expect(S.manage.resume(U.v1.actor, c.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' }) // empty wallet
  })

  it('validates bids and budgets against platform rules', async () => {
    const pid = await product(U.v1, 'Rules Phone')
    const base = { name: 'Rules', targeting: 'AUTO', productIds: [pid] }
    await expect(S.manage.createCampaign(U.v1.actor, { ...base, defaultBid: 1, dailyBudget: 200 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(S.manage.createCampaign(U.v1.actor, { ...base, defaultBid: 9999, dailyBudget: 200 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(S.manage.createCampaign(U.v1.actor, { ...base, defaultBid: 10, dailyBudget: 50 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(S.manage.createCampaign(U.v1.actor, { ...base, defaultBid: 10, dailyBudget: 200, totalBudget: 100 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('a vendor can only advertise products they sell, and cannot see another vendor\'s campaign', async () => {
    const mine = await product(U.v1, 'Mine')
    const theirs = await product(U.v2, 'Theirs')
    await expect(S.manage.createCampaign(U.v1.actor, { name: 'Steal', targeting: 'AUTO', defaultBid: 10, dailyBudget: 200, productIds: [theirs] }))
      .rejects.toMatchObject({ code: 'NOT_YOUR_PRODUCT' })
    const c = await S.manage.createCampaign(U.v1.actor, { name: 'Mine', targeting: 'AUTO', defaultBid: 10, dailyBudget: 200, productIds: [mine] })
    await expect(S.manage.getCampaign(U.v2.actor, c.id)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 })
    await expect(S.manage.pause(U.v2.actor, c.id)).rejects.toMatchObject({ statusCode: 404 })
    expect((await S.manage.listCampaigns(U.v2.actor, {})).data).toHaveLength(0)
    expect((await S.manage.listCampaigns(U.v1.actor, {})).data).toHaveLength(1)
  })

  it('manual campaigns need a keyword before they can be submitted', async () => {
    const pid = await product(U.v1, 'No Kw')
    const c = await S.manage.createCampaign(U.v1.actor, { name: 'No keywords', targeting: 'MANUAL', defaultBid: 10, dailyBudget: 200, productIds: [pid] })
    await expect(S.manage.submit(U.v1.actor, c.id)).rejects.toMatchObject({ code: 'INCOMPLETE' })
  })

  // ── serving ───────────────────────────────────────────────────────────

  it('serves matching ads, prices them second-price, and hides the price from the payload', async () => {
    const p1 = await product(U.v1, 'Zephyr phone case')
    const p2 = await product(U.v2, 'Zephyr phone cover')
    await fund(U.v1, 1000); await fund(U.v2, 1000)
    await liveCampaign(U.v1, p1, { keyword: 'zephyr', bid: 20 })
    await liveCampaign(U.v2, p2, { keyword: 'zephyr', bid: 9 })
    const ads = await S.serve.serve({ q: 'Zephyr Phone', pincode: '700001' })
    expect(ads.map((a) => a.product_id)).toEqual([p1, p2])
    expect(ads.every((a) => a.is_sponsored && a.ad.label === 'Sponsored')).toBe(true)
    const t = S.shared.verifyImpression(ads[0].ad.token)
    expect(t.b).toBeGreaterThan(9)   // beats the runner-up…
    expect(t.b).toBeLessThan(20)     // …but pays less than its own bid
    expect(JSON.stringify(ads[0])).not.toMatch(/"bid"|"cpc"/)
  })

  it('does not serve ads that are paused, unfunded, over budget, negative-matched, or unrelated', async () => {
    const p = await product(U.v1, 'Quasar speaker')
    const c = await liveCampaign(U.v1, p, { keyword: 'quasar', bid: 10 })
    expect(await S.serve.serve({ q: 'quasar' })).toHaveLength(0) // no money in the wallet
    await fund(U.v1, 1000)
    expect(await S.serve.serve({ q: 'quasar' })).toHaveLength(1)
    expect(await S.serve.serve({ q: 'unrelated thing' })).toHaveLength(0)
    await S.manage.addKeywords(U.admin, c.id, { keywords: [{ keyword: 'cheap', matchType: 'BROAD', negative: true }] })
    expect(await S.serve.serve({ q: 'cheap quasar' })).toHaveLength(0)
    expect(await S.serve.serve({ q: 'quasar' })).toHaveLength(1)
    await S.manage.pause(U.admin, c.id)
    expect(await S.serve.serve({ q: 'quasar' })).toHaveLength(0)
  })

  it('does not serve out-of-stock or unapproved listings', async () => {
    const p = await product(U.v1, 'Nebula lamp')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'nebula', bid: 10 })
    expect(await S.serve.serve({ q: 'nebula' })).toHaveLength(1)
    await q(`UPDATE shop_products SET stock_quantity = 0 WHERE product_id = $1`, [p])
    expect(await S.serve.serve({ q: 'nebula' })).toHaveLength(0)
    await q(`UPDATE shop_products SET stock_quantity = 5 WHERE product_id = $1`, [p])
    await q(`UPDATE shop_products SET approval_status = 'REJECTED' WHERE product_id = $1`, [p])
    expect(await S.serve.serve({ q: 'nebula' })).toHaveLength(0)
  })

  it('AUTO campaigns serve on text relevance at the campaign bid', async () => {
    const p = await product(U.v3, 'Orchid planter')
    await fund(U.v3, 1000)
    await liveCampaign(U.v3, p, { targeting: 'AUTO', bid: 12 })
    const ads = await S.serve.serve({ q: 'orchid' })
    expect(ads).toHaveLength(1)
    expect(S.shared.verifyImpression(ads[0].ad.token).b).toBe(2) // alone in the auction → floor price
  })

  it('merges sponsored into search results without breaking when ads fail', async () => {
    const p = await product(U.v1, 'Helix kettle')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'helix', bid: 10 })
    const organic = { data: [{ product_id: 'x1' }, { product_id: 'x2' }], pagination: {} }
    const out = await S.serve.injectSponsored(organic, { q: 'helix' })
    expect(out.data[0].is_sponsored).toBe(true)
    expect(out.data).toHaveLength(3)
    await q(`UPDATE ad_settings SET enabled = FALSE`); S.shared.invalidateSettingsCache()
    expect((await S.serve.injectSponsored(organic, { q: 'helix' })).data).toHaveLength(2)
  })

  // ── billing ───────────────────────────────────────────────────────────

  const clickOnce = async (vendor, productId, kw, { userId = U.shopper, ip = '1.1.1.1' } = {}) => {
    const ads = await S.serve.serve({ q: kw })
    const ad = ads.find((a) => a.product_id === productId)
    return { ad, result: ad ? await S.billing.registerClick({ token: ad.ad.token, userId, ip }) : null }
  }

  it('charges exactly the displayed CPC + GST once, and replaying a token never double-charges', async () => {
    const p = await product(U.v1, 'Vortex fan')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'vortex', bid: 10 })
    const { ad, result } = await clickOnce(U.v1, p, 'vortex')
    expect(result.charged).toBe(true)
    const cpc = S.shared.verifyImpression(ad.ad.token).b
    expect(await balance(U.v1)).toBeCloseTo(1000 - cpc * 1.18, 2)
    const replay = await S.billing.registerClick({ token: ad.ad.token, userId: U.shopper, ip: '1.1.1.1' })
    expect(replay).toMatchObject({ charged: false, reason: 'DUPLICATE' })
    expect(await balance(U.v1)).toBeCloseTo(1000 - cpc * 1.18, 2)
    const stats = await one(`SELECT SUM(clicks)::int AS clicks, SUM(spend) AS spend FROM ad_stats_daily WHERE product_id = $1`, [p])
    expect(stats.clicks).toBe(1)
    expect(Number(stats.spend)).toBeCloseTo(cpc, 2)
    const led = await one(`SELECT amount, tax_amount, balance_after FROM ad_wallet_ledger WHERE entry_type = 'CLICK_CHARGE' AND vendor_id = $1`, [U.v1.id])
    expect(Number(led.amount)).toBeCloseTo(-cpc * 1.18, 2)
    expect(Number(led.tax_amount)).toBeCloseTo(cpc * 0.18, 2)
  })

  it('rejects forged, tampered and expired tokens', async () => {
    const p = await product(U.v1, 'Forge fan')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'forge', bid: 10 })
    const [ad] = await S.serve.serve({ q: 'forge' })
    const [body, sig] = ad.ad.token.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), b: 0.01 })).toString('base64url')
    await expect(S.billing.registerClick({ token: `${forgedBody}.${sig}` })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(S.billing.registerClick({ token: 'garbage' })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    const expired = S.shared.signImpression({ ...S.shared.verifyImpression(ad.ad.token), e: Date.now() - 1000 })
    await expect(S.billing.registerClick({ token: expired })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    expect(await balance(U.v1)).toBe(1000)
  })

  it('does not charge the same shopper twice inside the dedupe window, but does charge a different shopper', async () => {
    const p = await product(U.v1, 'Dupe fan')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'dupe', bid: 10 })
    expect((await clickOnce(U.v1, p, 'dupe')).result.charged).toBe(true)
    expect((await clickOnce(U.v1, p, 'dupe')).result).toMatchObject({ charged: false, reason: 'DUPLICATE' })
    expect((await clickOnce(U.v1, p, 'dupe', { userId: U.shopper2 })).result.charged).toBe(true)
  })

  it('vendor staff clicking their own ad is free', async () => {
    const p = await product(U.v1, 'Self fan')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'self', bid: 10 })
    const { result } = await clickOnce(U.v1, p, 'self', { userId: U.staff })
    expect(result).toMatchObject({ charged: false, reason: 'SELF_CLICK' })
    expect(await balance(U.v1)).toBe(1000)
  })

  it('never overspends the daily budget, even under concurrent clicks', async () => {
    const p = await product(U.v1, 'Budget fan')
    await fund(U.v1, 5000)
    // ₹100 daily budget (the platform minimum), bidding ₹10 against nobody → ₹2 floor price → 50 clicks fit.
    const c = await liveCampaign(U.v1, p, { keyword: 'budgetfan', bid: 10, daily: 100 })
    await q(`UPDATE ad_settings SET min_cpc = 40, max_cpc = 500 WHERE id = TRUE`); S.shared.invalidateSettingsCache()
    await q(`UPDATE ad_campaigns SET default_bid = 40 WHERE id = $1`, [c.id])
    const tokens = []
    for (let i = 0; i < 6; i++) {
      const [ad] = await S.serve.serve({ q: 'budgetfan' })
      tokens.push(ad.ad.token)
    }
    // ₹40 each, ₹100 budget → only 2 can be charged no matter the interleaving.
    const results = await Promise.all(tokens.map((token, i) => S.billing.registerClick({ token, userId: null, ip: `9.9.9.${i}` })))
    expect(results.filter((r) => r.charged)).toHaveLength(2)
    expect(results.filter((r) => r.reason === 'BUDGET_EXHAUSTED')).toHaveLength(4)
    const spent = await one(`SELECT SUM(spend) AS s FROM ad_stats_daily WHERE campaign_id = $1`, [c.id])
    expect(Number(spent.s)).toBeLessThanOrEqual(100)
  })

  it('pauses the campaign (and does not charge) when the wallet runs dry', async () => {
    const p = await product(U.v1, 'Dry fan')
    await fund(U.v1, 500)
    const c = await liveCampaign(U.v1, p, { keyword: 'dry', bid: 10 })
    const [ad] = await S.serve.serve({ q: 'dry' })
    await q(`UPDATE ad_wallets SET balance = 1 WHERE vendor_id = $1`, [U.v1.id]) // drained after the impression was served
    const r = await S.billing.registerClick({ token: ad.ad.token, userId: U.shopper, ip: '2.2.2.2' })
    expect(r).toMatchObject({ charged: false, reason: 'NO_FUNDS' })
    expect(await balance(U.v1)).toBe(1)
    const after = await S.manage.getCampaign(U.admin, c.id)
    expect(after.status).toBe('PAUSED')
    expect(after.paused_reason).toBe('OUT_OF_FUNDS')
  })

  it('does not charge for a click on a campaign that was paused after the impression', async () => {
    const p = await product(U.v1, 'Late fan')
    await fund(U.v1, 500)
    const c = await liveCampaign(U.v1, p, { keyword: 'late', bid: 10 })
    const [ad] = await S.serve.serve({ q: 'late' })
    await S.manage.pause(U.admin, c.id)
    expect(await S.billing.registerClick({ token: ad.ad.token, userId: U.shopper, ip: '3.3.3.3' })).toMatchObject({ charged: false, reason: 'INACTIVE' })
    expect(await balance(U.v1)).toBe(500)
  })

  // ── wallet ────────────────────────────────────────────────────────────

  it('tops up from settlement balance atomically, idempotently, and never overdraws', async () => {
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason) VALUES ($1,'ADJUSTMENT',2000,2000,'seed')`, [U.v2.id])
    await expect(S.billing.topUpFromSettlement(U.v2.id, U.v2.actor, { amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' }) // below min top-up
    await expect(S.billing.topUpFromSettlement(U.v2.id, U.v2.actor, { amount: 5000 })).rejects.toMatchObject({ code: 'INSUFFICIENT_SETTLEMENT' })
    const r1 = await S.billing.topUpFromSettlement(U.v2.id, U.v2.actor, { amount: 800, idempotencyKey: 'abc' })
    const r2 = await S.billing.topUpFromSettlement(U.v2.id, U.v2.actor, { amount: 800, idempotencyKey: 'abc' })
    expect(r1.balance).toBe(800)
    expect(r2.replayed).toBe(true)
    const sb = await one(`SELECT SUM(amount) AS b FROM settlement_ledger WHERE vendor_id = $1`, [U.v2.id])
    expect(Number(sb.b)).toBe(1200)
    // concurrent top-ups can't take more than the settlement balance
    const res = await Promise.allSettled([1, 2, 3].map(() => S.billing.topUpFromSettlement(U.v2.id, U.v2.actor, { amount: 600 })))
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(2)
    const sb2 = await one(`SELECT SUM(amount) AS b FROM settlement_ledger WHERE vendor_id = $1`, [U.v2.id])
    expect(Number(sb2.b)).toBe(0)
    expect(await balance(U.v2)).toBe(2000)
  })

  it('blocks settlement top-up while a settlement hold is active', async () => {
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason) VALUES ($1,'ADJUSTMENT',2000,2000,'seed')`, [U.v3.id])
    await q(`INSERT INTO settlement_holds (vendor_id, reason, is_active) VALUES ($1,'dispute',TRUE)`, [U.v3.id])
    await expect(S.billing.topUpFromSettlement(U.v3.id, U.v3.actor, { amount: 600 })).rejects.toMatchObject({ code: 'SETTLEMENT_HOLD' })
    await q(`DELETE FROM settlement_holds WHERE vendor_id = $1`, [U.v3.id])
  })

  it('withdraws only settlement-funded, unused balance (promo credit is not withdrawable)', async () => {
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason) VALUES ($1,'ADJUSTMENT',1000,1000,'seed')`, [U.v2.id])
    await S.billing.topUpFromSettlement(U.v2.id, U.v2.actor, { amount: 600 })
    await S.billing.adminCredit(U.v2.id, U.admin, { amount: 300, kind: 'PROMO_CREDIT', reason: 'welcome credit' })
    await expect(S.billing.withdrawToSettlement(U.v2.id, U.v2.actor, { amount: 800 })).rejects.toMatchObject({ code: 'NOT_WITHDRAWABLE' })
    await S.billing.withdrawToSettlement(U.v2.id, U.v2.actor, { amount: 600 })
    expect(await balance(U.v2)).toBe(300)
    const sb = await one(`SELECT SUM(amount) AS b FROM settlement_ledger WHERE vendor_id = $1`, [U.v2.id])
    expect(Number(sb.b)).toBe(1000)
  })

  it('platform refunds an invalid click (incl. GST) exactly once', async () => {
    const p = await product(U.v1, 'Refund fan')
    await fund(U.v1, 1000)
    await liveCampaign(U.v1, p, { keyword: 'refundfan', bid: 10 })
    await clickOnce(U.v1, p, 'refundfan')
    const after = await balance(U.v1)
    expect(after).toBeLessThan(1000)
    const click = await one(`SELECT id FROM ad_clicks WHERE product_id = $1 AND charged`, [p])
    await expect(S.billing.refundClick(U.admin, click.id, '')).rejects.toMatchObject({ code: 'VALIDATION' })
    const r = await S.billing.refundClick(U.admin, click.id, 'bot traffic')
    expect(r.refunded).toBe(true)
    expect(await balance(U.v1)).toBeCloseTo(1000, 2)
    expect((await S.billing.refundClick(U.admin, click.id, 'again')).alreadyRefunded).toBe(true)
    expect(await balance(U.v1)).toBeCloseTo(1000, 2)
  })

  it('ledger reconstructs the wallet balance exactly', async () => {
    const p = await product(U.v1, 'Ledger fan')
    await fund(U.v1, 700)
    await liveCampaign(U.v1, p, { keyword: 'ledgerfan', bid: 10 })
    await clickOnce(U.v1, p, 'ledgerfan')
    await clickOnce(U.v1, p, 'ledgerfan', { userId: U.shopper2 })
    const sum = await one(`SELECT SUM(amount) AS s FROM ad_wallet_ledger WHERE vendor_id = $1`, [U.v1.id])
    expect(Number(sum.s)).toBeCloseTo(await balance(U.v1), 2)
  })

  // ── reporting ─────────────────────────────────────────────────────────

  it('attributes later orders for the clicked product to the ad (last click, within window)', async () => {
    const p = await product(U.v1, 'Attrib fan', 1000)
    await fund(U.v1, 1000)
    const c = await liveCampaign(U.v1, p, { keyword: 'attribfan', bid: 10 })
    await clickOnce(U.v1, p, 'attribfan')
    const o = await one(
      `INSERT INTO orders (order_number, customer_id, status, items, subtotal, total_payable, delivery_address)
       VALUES ($1,$2,'DELIVERED','[]'::jsonb,1000,1000,'{}'::jsonb) RETURNING id`, [`ATT${rand()}`.slice(0, 20), U.shopper])
    await q(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, product_snapshot) VALUES ($1,$2,'Attrib fan',1000,1,1000,'{}'::jsonb)`, [o.id, p])
    const rep = await S.manage.campaignReport(U.admin, c.id, { days: 7 })
    expect(rep.totals.clicks).toBe(1)
    expect(rep.totals.orders).toBe(1)
    expect(rep.totals.sales).toBe(1000)
    expect(rep.totals.acos).toBeGreaterThan(0)
    expect(rep.keywords[0]).toMatchObject({ keyword: 'attribfan', orders: 1 })
    await q(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [o.id])
    expect((await S.manage.campaignReport(U.admin, c.id, { days: 7 })).totals.orders).toBe(0)
  })

  it('overview is scoped: vendors see themselves, admins see the platform', async () => {
    const p1 = await product(U.v1, 'Scope fan one')
    const p2 = await product(U.v2, 'Scope fan two')
    await fund(U.v1, 1000); await fund(U.v2, 1000)
    await liveCampaign(U.v1, p1, { keyword: 'scopefan', bid: 10 })
    await liveCampaign(U.v2, p2, { keyword: 'scopefan', bid: 10 })
    await clickOnce(U.v1, p1, 'scopefan')
    await clickOnce(U.v2, p2, 'scopefan')
    const v1 = await S.manage.overview(U.v1.actor, { days: 7 })
    const adm = await S.manage.overview(U.admin, { days: 7 })
    expect(v1.totals.clicks).toBe(1)
    expect(adm.totals.clicks).toBe(2)
    expect(v1.wallet.balance).toBeLessThan(1000)
    expect(adm.platform.wallet_liability).toBeGreaterThan(0)
    expect(v1.platform).toBeUndefined()
  })

  it('keyword research reports competition and a suggested bid within platform limits', async () => {
    const p = await product(U.v1, 'Research fan')
    await liveCampaign(U.v1, p, { keyword: 'researchfan', bid: 30 })
    const e = await S.manage.estimate(U.v2.actor, { keyword: 'Research Fan', matchType: 'BROAD' })
    expect(e.keyword).toBe('research fan')
    const e2 = await S.manage.estimate(U.v2.actor, { keyword: 'researchfan' })
    expect(e2.competing_campaigns).toBe(1)
    expect(e2.suggested_bid).toBeGreaterThanOrEqual(2)
    expect(e2.suggested_bid).toBeLessThanOrEqual(500)
  })
})
