/**
 * Subscriptions + vendor timeline + alerts — real Postgres.
 *
 *   SUBS_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/subscriptions.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.SUBS_TEST_DB ? describe : describe.skip

d('subscriptions (real database)', () => {
  let q, svc, listings, timeline
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const photos = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']
  const mkVendor = async (name) => (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`,
    [name, 's-' + rand(), `s${rand()}@t.io`, '76' + rand()])).rows[0]
  const mkShop = async (vid) => q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
    VALUES ('S',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,5,true)`, ['ss-' + rand(), 'S' + rand().slice(0, 6), vid])
  const list = (vid, i) => listings.create({ name: 'Sub Phone ' + i + rand(), categoryId: F.cat.id, condition: 'NEW', price: 5000, mrp: 6000, stock: 2, images: photos },
    { vendorId: vid, actorId: F.admin.id })

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    const { SubscriptionsService } = await import('../../src/modules/subscriptions/subscriptions.service.js')
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    timeline = (await import('../../src/modules/subscriptions/vendor-timeline.service.js')).vendorTimeline
    svc = new SubscriptionsService()
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Sub Admin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.cat = (await q(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, ['Sub Cat ' + rand(), 'sc-' + rand()])).rows[0]
  })
  afterAll(async () => {})

  it('seeds the four plans and treats a new vendor as Free', async () => {
    const plans = await svc.plans()
    expect(plans.map((p) => p.tier)).toEqual(['FREE', 'PAID', 'PREMIUM', 'UNLIMITED'])
    expect(plans[3].listing_limit).toBeNull()
    const v = await mkVendor('Fresh Vendor')
    const det = await svc.vendor(v.id)
    expect(det).toMatchObject({ tier: 'FREE', plan_name: 'Free', listing_limit: 25, listings_used: 0 })
  })

  it('plan edits are validated (Free stays ₹0, only Unlimited is unlimited)', async () => {
    const plans = await svc.plans()
    const free = plans.find((p) => p.tier === 'FREE'); const paid = plans.find((p) => p.tier === 'PAID'); const unl = plans.find((p) => p.tier === 'UNLIMITED')
    await expect(svc.updatePlan(free.id, { priceMonthly: 10 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updatePlan(free.id, { isActive: false })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updatePlan(paid.id, { listingLimit: null })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updatePlan(unl.id, { listingLimit: 5 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.updatePlan(paid.id, { priceMonthly: -1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    const upd = await svc.updatePlan(paid.id, { priceMonthly: 1099, features: ['Up to 200 listings', 'Priority review'] })
    expect(Number(upd.price_monthly)).toBe(1099)
    await svc.updatePlan(paid.id, { priceMonthly: 999 })
  })

  it('assign: paid plan needs a payment reference; complimentary needs days; then it is live with an expiry', async () => {
    const v = await mkVendor('Assign Vendor')
    await expect(svc.assign(v.id, { tier: 'PAID', cycle: 'MONTHLY' }, F.admin.id)).rejects.toMatchObject({ code: 'PAYMENT_REF_REQUIRED' })
    await expect(svc.assign(v.id, { tier: 'PREMIUM', cycle: 'COMPLIMENTARY' }, F.admin.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.assign(v.id, { tier: 'GOLD' }, F.admin.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    const a = await svc.assign(v.id, { tier: 'PAID', cycle: 'MONTHLY', paymentRef: 'UTR123456' }, F.admin.id)
    expect(a).toMatchObject({ tier: 'PAID', listing_limit: 200, amount_paid: 999 })
    const days = (new Date(a.expires_at) - Date.now()) / 86400000
    expect(days).toBeGreaterThan(27); expect(days).toBeLessThan(32)
    expect(a.events[0]).toMatchObject({ event: 'ASSIGNED', to_tier: 'PAID' })
  })

  it('renewing the same plan stacks time; changing plan replaces the row; downgrade to Free cancels', async () => {
    const v = await mkVendor('Renew Vendor')
    const first = await svc.assign(v.id, { tier: 'PAID', cycle: 'MONTHLY', paymentRef: 'UTR-A' }, F.admin.id)
    const renewed = await svc.assign(v.id, { tier: 'PAID', cycle: 'MONTHLY', paymentRef: 'UTR-B' }, F.admin.id)
    const gain = (new Date(renewed.expires_at) - new Date(first.expires_at)) / 86400000
    expect(gain).toBeGreaterThan(27)
    expect(renewed.events[0].event).toBe('RENEWED')
    const up = await svc.assign(v.id, { tier: 'PREMIUM', cycle: 'YEARLY', paymentRef: 'UTR-C' }, F.admin.id)
    expect(up).toMatchObject({ tier: 'PREMIUM', amount_paid: 29990 })
    expect(up.events[0]).toMatchObject({ event: 'CHANGED', from_tier: 'PAID', to_tier: 'PREMIUM' })
    expect((await q(`SELECT COUNT(*)::int n FROM vendor_subscriptions WHERE vendor_id = $1 AND status = 'ACTIVE'`, [v.id])).rows[0].n).toBe(1)
    await expect(svc.cancel(v.id, 'no', F.admin.id)).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    const down = await svc.cancel(v.id, 'Vendor asked to downgrade', F.admin.id)
    expect(down.tier).toBe('FREE')
    expect(down.history.find((h) => h.status === 'CANCELLED')).toBeTruthy()
  })

  it('extend adds days with a reason and logs it', async () => {
    const v = await mkVendor('Extend Vendor')
    await expect(svc.extend(v.id, 7, 'goodwill gesture', F.admin.id)).rejects.toMatchObject({ code: 'NO_SUBSCRIPTION' })
    const a = await svc.assign(v.id, { tier: 'PAID', cycle: 'COMPLIMENTARY', days: 10 }, F.admin.id)
    await expect(svc.extend(v.id, 0, 'goodwill gesture', F.admin.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.extend(v.id, 7, '', F.admin.id)).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    const e = await svc.extend(v.id, 7, 'Goodwill after outage', F.admin.id)
    expect((new Date(e.expires_at) - new Date(a.expires_at)) / 86400000).toBeCloseTo(7, 0)
    expect(e.events[0].event).toBe('EXTENDED')
  })

  it('listing limit: a vendor on Free stops at 25; a bigger plan lifts it; admin listings are not blocked', async () => {
    const v = await mkVendor('Limit Vendor'); await mkShop(v.id)
    await q(`UPDATE subscription_plans SET listing_limit = 2 WHERE tier = 'FREE'`)
    try {
      await list(v.id, 1); await list(v.id, 2)
      await expect(list(v.id, 3)).rejects.toMatchObject({ code: 'LISTING_LIMIT' })
      expect((await svc.me(v.id))).toMatchObject({ tier: 'FREE', listingLimit: 2, listingsUsed: 2 })
      await svc.assign(v.id, { tier: 'PAID', cycle: 'MONTHLY', paymentRef: 'UTR-L' }, F.admin.id)
      await expect(list(v.id, 3)).resolves.toBeTruthy()
    } finally { await q(`UPDATE subscription_plans SET listing_limit = 25 WHERE tier = 'FREE'`) }
  })

  it('lists vendors by tier and flags those expiring soon', async () => {
    const v = await mkVendor('Soon Vendor')
    await svc.assign(v.id, { tier: 'PREMIUM', cycle: 'COMPLIMENTARY', days: 3 }, F.admin.id)
    const prem = await svc.vendors({ tier: 'PREMIUM' })
    expect(prem.data.map((r) => r.id)).toContain(v.id)
    const soon = await svc.vendors({ expiring: true })
    const row = soon.data.find((r) => r.id === v.id)
    expect(row.days_left).toBeLessThanOrEqual(3)
    expect((await svc.overview()).expiringSoon).toBeGreaterThan(0)
  })

  it('sweep expires lapsed plans (vendor falls back to Free) and raises each alert once', async () => {
    const v = await mkVendor('Lapse Vendor')
    await svc.assign(v.id, { tier: 'PAID', cycle: 'COMPLIMENTARY', days: 5 }, F.admin.id)
    const s1 = await svc.sweep()
    expect(s1.expiring).toBeGreaterThanOrEqual(1)
    const again = await svc.sweep()
    expect(again.expiring).toBe(0) // already warned
    expect((await q(`SELECT COUNT(*)::int n FROM admin_alerts WHERE type = 'SUBSCRIPTION_EXPIRING' AND entity_id = $1`, [v.id])).rows[0].n).toBe(1)

    await q(`UPDATE vendor_subscriptions SET expires_at = NOW() - interval '1 hour' WHERE vendor_id = $1 AND status = 'ACTIVE'`, [v.id])
    expect((await svc.vendor(v.id)).tier).toBe('FREE') // lapsed even before the sweep marks it
    const s2 = await svc.sweep()
    expect(s2.expired).toBeGreaterThanOrEqual(1)
    expect((await svc.vendor(v.id)).history[0].status).toBe('EXPIRED')
    expect((await q(`SELECT COUNT(*)::int n FROM admin_alerts WHERE type = 'SUBSCRIPTION_EXPIRED' AND entity_id = $1`, [v.id])).rows[0].n).toBe(1)
    expect((await svc.sweep()).expired).toBe(0)
  })

  it('vendor timeline reflects real activity and marks untouched stages as not done', async () => {
    const v = await mkVendor('Timeline Vendor'); await mkShop(v.id)
    await q(`INSERT INTO vendor_kyc_reviews (vendor_id, reviewer_id, action, previous_status, new_status, comments) VALUES ($1,$2,'APPROVE','KYC_SUBMITTED','VERIFIED','all documents valid')`, [v.id, F.admin.id])
    await svc.assign(v.id, { tier: 'PAID', cycle: 'MONTHLY', paymentRef: 'UTR-T' }, F.admin.id)
    await list(v.id, 1); await list(v.id, 2)
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, idempotency_key) VALUES ($1,'GROSS_SALES',1000,1000,$2)`, [v.id, 'tl:' + rand()])
    const t = await timeline(v.id)
    const by = Object.fromEntries(t.stages.map((s) => [s.key, s]))
    expect(t.stages.map((s) => s.key)).toEqual(['REGISTERED', 'APPROVED', 'SUBSCRIPTION', 'PRODUCTS', 'ORDERS', 'SALES', 'COMMISSION', 'WALLET', 'REFUNDS', 'REVIEWS', 'AUCTION', 'RENEWAL'])
    expect(by.REGISTERED.done && by.APPROVED.done && by.SUBSCRIPTION.done && by.PRODUCTS.done && by.WALLET.done).toBe(true)
    expect(by.PRODUCTS.metrics.find((m) => m.label === 'Listings').value).toBe(2)
    expect(by.SUBSCRIPTION.metrics[0].value).toBe('Paid')
    expect(by.WALLET.metrics.find((m) => m.label === 'Balance').value).toBe(1000)
    expect(by.ORDERS.done || by.SALES.done || by.REFUNDS.done || by.REVIEWS.done || by.AUCTION.done).toBe(false)
    expect(t.feed.map((f) => f.title)).toEqual(expect.arrayContaining(['Vendor registered', 'First product listed']))
    expect(await timeline('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('alerts are idempotent through their dedupe key and never throw', async () => {
    const { emitAlert } = await import('../../src/modules/alerts/alerts.service.js')
    const k = 'test-' + rand()
    const a = await emitAlert({ type: 'LOW_STOCK', title: 'x', dedupeKey: k })
    const b = await emitAlert({ type: 'LOW_STOCK', title: 'x', dedupeKey: k })
    expect(a).toBeTruthy(); expect(b).toBeNull()
    await expect(emitAlert({ type: 'X', title: 'x', severity: 'NOPE' })).resolves.toBeNull() // CHECK violation swallowed
  })
})
