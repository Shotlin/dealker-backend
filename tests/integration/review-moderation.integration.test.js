/**
 * Review moderation (product + vendor reviews) — real Postgres.
 *
 *   REVIEWS_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   npx vitest run tests/integration/review-moderation.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.REVIEWS_TEST_DB ? describe : describe.skip

d('review moderation (real database)', () => {
  let q, mod, svc, reviews
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const mkUser = async (name) => (await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, ['7' + rand(), name])).rows[0].id

  /** A delivered order containing `productId`, with a delivered seller order from the vendor. */
  async function mkDelivered(customerId, productId, { status = 'DELIVERED', sellerStatus = 'DELIVERED' } = {}) {
    const o = (await q(
      `INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, payment_method, payment_status, delivery_address)
       VALUES ($1,$2,TRUE,$3,$4::jsonb,1000,1000,'ONLINE','PAID','{}'::jsonb) RETURNING id`,
      ['RV-' + rand(), customerId, status, JSON.stringify([{ productId, quantity: 1 }])])).rows[0]
    await q(`INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, shop_id, status, item_subtotal, commission_amount, payable_to_seller)
             VALUES ($1,$2,$3,$4,$5,1000,100,900)`, [o.id, 'RSO-' + rand(), F.vendor.id, F.shop.id, sellerStatus])
    return o.id
  }
  const mkProduct = async () => (await q(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('Review Phone',$1,1000,'VENDOR',$2,true) RETURNING id`,
    ['rp-' + rand(), F.vendor.id])).rows[0].id
  const rating = async (pid) => (await q(`SELECT avg_rating, rating_avg, rating_count FROM products WHERE id = $1`, [pid])).rows[0]
  const publicList = async (pid) => (await reviews.getProductReviews(pid, { page: 1, limit: 50 }))
  /** Customer submits a product review on a fresh delivered order. */
  async function submit(pid, stars, comment = 'ok', userId) {
    const uid = userId || (await mkUser('Rev ' + rand()))
    const orderId = await mkDelivered(uid, pid)
    const r = await reviews.createReview(uid, { productId: pid, orderId, rating: stars, comment })
    return { ...r, uid, orderId }
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    mod = await import('../../src/modules/reviews/review-moderation.service.js')
    svc = mod.reviewModeration
    const { ReviewsService } = await import('../../src/modules/reviews/reviews.service.js')
    const { ReviewsRepository } = await import('../../src/modules/reviews/reviews.repository.js')
    reviews = new ReviewsService(new ReviewsRepository())
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Rev Admin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0].id
    F.vendor = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Review Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['rv-' + rand(), `r${rand()}@t.io`, '65' + rand()])).rows[0]
    F.shop = (await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('Review Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['rs-' + rand(), 'R' + rand().slice(0, 6), F.vendor.id])).rows[0]
    await svc.updateSettings({ autoPublish: false })
  })
  afterAll(async () => { await svc.updateSettings({ autoPublish: false }) })

  it('a new review waits for moderation: invisible to the public, uncounted, but visible to its author', async () => {
    const pid = await mkProduct()
    const r = await submit(pid, 5, 'Loved it')
    expect(r.status).toBe('SUBMITTED')
    expect((await publicList(pid)).reviews).toHaveLength(0)
    expect(await rating(pid)).toMatchObject({ rating_count: 0 })
    const mine = await reviews.getReviewsByOrder(r.uid, r.orderId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ status: 'SUBMITTED', rating: 5 })
    // the same order can't be reviewed twice while it waits
    await expect(reviews.createReview(r.uid, { productId: pid, orderId: r.orderId, rating: 4 })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('publishing shows the review and feeds the product rating; hiding takes it back out', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 5)
    const b = await submit(pid, 2)
    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    expect(await rating(pid)).toMatchObject({ avg_rating: '5.0', rating_avg: '5.00', rating_count: 1 })
    await svc.moderate('product', b.id, 'APPROVE', {}, F.admin) // approved ≠ published yet
    expect((await publicList(pid)).reviews.map((x) => x.id)).toEqual([a.id])
    await svc.moderate('product', b.id, 'PUBLISH', {}, F.admin)
    const pub = await publicList(pid)
    expect(pub.reviews).toHaveLength(2)
    expect(pub.averageRating).toBe(3.5)
    expect(await rating(pid)).toMatchObject({ avg_rating: '3.5', rating_count: 2 })

    await svc.moderate('product', b.id, 'HIDE', { note: 'spam' }, F.admin)
    expect((await publicList(pid)).reviews.map((x) => x.id)).toEqual([a.id])
    expect(await rating(pid)).toMatchObject({ avg_rating: '5.0', rating_count: 1 })
    // a hidden review can come back, and moderation keeps who/why
    const back = await svc.moderate('product', b.id, 'PUBLISH', {}, F.admin)
    expect(back).toMatchObject({ status: 'PUBLISHED', moderation_note: null })
    expect((await q(`SELECT moderated_by FROM reviews WHERE id = $1`, [b.id])).rows[0].moderated_by).toBe(F.admin)
  })

  it('enforces the state machine and requires a reason for reject / remove', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 3)
    await expect(svc.moderate('product', a.id, 'REJECT', {}, F.admin)).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expect(svc.moderate('product', a.id, 'HIDE', {}, F.admin)).rejects.toMatchObject({ statusCode: 409, code: 'BAD_STATE' }) // not published
    await expect(svc.moderate('product', a.id, 'RESTORE', {}, F.admin)).rejects.toMatchObject({ statusCode: 409 })
    await expect(svc.moderate('product', a.id, 'LAUNCH', {}, F.admin)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.moderate('product', '00000000-0000-0000-0000-000000000000', 'PUBLISH', {}, F.admin)).rejects.toMatchObject({ statusCode: 404 })
    await expect(svc.moderate('banana', a.id, 'PUBLISH', {}, F.admin)).rejects.toMatchObject({ code: 'VALIDATION' })

    await svc.moderate('product', a.id, 'REJECT', { note: 'Contains a phone number' }, F.admin)
    await expect(svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)).rejects.toMatchObject({ statusCode: 409 }) // rejected: restore first
    const restored = await svc.moderate('product', a.id, 'RESTORE', {}, F.admin)
    expect(restored.status).toBe('SUBMITTED')
    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    await svc.moderate('product', a.id, 'REMOVE', { note: 'Abusive' }, F.admin)
    expect((await publicList(pid)).reviews).toHaveLength(0)
    expect(await rating(pid)).toMatchObject({ avg_rating: '0.0', rating_count: 0 })
  })

  it('two admins deciding the same review at once: exactly one wins, ratings match the winner', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 4)
    const results = await Promise.allSettled([
      svc.moderate('product', a.id, 'PUBLISH', {}, F.admin),
      svc.moderate('product', a.id, 'REJECT', { note: 'duplicate' }, F.admin),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ statusCode: 409 })
    const { status } = (await q(`SELECT status FROM reviews WHERE id = $1`, [a.id])).rows[0]
    expect((await rating(pid)).rating_count).toBe(status === 'PUBLISHED' ? 1 : 0)
  })

  it('editing a published review sends it back to moderation and out of the rating; hidden/removed ones are locked', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 5, 'Great')
    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    expect((await rating(pid)).rating_count).toBe(1)

    // identical content: nothing changes
    await reviews.updateReview(a.uid, a.id, { rating: 5, comment: 'Great' })
    expect((await q(`SELECT status FROM reviews WHERE id = $1`, [a.id])).rows[0].status).toBe('PUBLISHED')

    const edited = await reviews.updateReview(a.uid, a.id, { comment: 'Great, call me on 98xxxxxxxx' })
    expect(edited.status).toBe('SUBMITTED')
    expect((await publicList(pid)).reviews).toHaveLength(0)
    expect((await rating(pid)).rating_count).toBe(0)

    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    await svc.moderate('product', a.id, 'HIDE', {}, F.admin)
    await expect(reviews.updateReview(a.uid, a.id, { comment: 'let me back in' })).rejects.toMatchObject({ statusCode: 403 })
    await expect(reviews.deleteReview(a.uid, a.id)).rejects.toMatchObject({ statusCode: 403 }) // can't dodge by deleting
    // someone else can't touch it either
    await expect(reviews.updateReview(F.admin, a.id, { comment: 'x' })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a rejected review can be edited and resubmitted; deleting a published one updates the rating', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 1, 'bad words')
    await svc.moderate('product', a.id, 'REJECT', { note: 'profanity' }, F.admin)
    const again = await reviews.updateReview(a.uid, a.id, { comment: 'clean now' })
    expect(again.status).toBe('SUBMITTED')
    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    expect((await rating(pid)).rating_count).toBe(1)
    await reviews.deleteReview(a.uid, a.id)
    expect(await rating(pid)).toMatchObject({ avg_rating: '0.0', rating_count: 0 })
  })

  it('auto-publish setting makes new reviews go live at once', async () => {
    const pid = await mkProduct()
    await svc.updateSettings({ autoPublish: true })
    try {
      const a = await submit(pid, 4)
      expect(a.status).toBe('PUBLISHED')
      expect((await publicList(pid)).reviews).toHaveLength(1)
      expect(await rating(pid)).toMatchObject({ avg_rating: '4.0', rating_count: 1 })
    } finally {
      await svc.updateSettings({ autoPublish: false })
    }
    await expect(svc.updateSettings({ autoPublish: 'yes' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const b = await submit(pid, 4)
    expect(b.status).toBe('SUBMITTED')
  })

  it('platform replies show under published reviews and can be cleared', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 2, 'Slow delivery')
    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    const r = await svc.reply('product', a.id, '  Sorry about that — we have fixed it.  ', F.admin)
    expect(r.admin_reply).toBe('Sorry about that — we have fixed it.')
    expect((await publicList(pid)).reviews[0]).toMatchObject({ admin_reply: 'Sorry about that — we have fixed it.' })
    const cleared = await svc.reply('product', a.id, '', F.admin)
    expect(cleared.admin_reply).toBeNull()
    expect(cleared.replied_at).toBeNull()
    await expect(svc.reply('product', a.id, 'x'.repeat(1001), F.admin)).rejects.toMatchObject({ code: 'VALIDATION' })
    await svc.moderate('product', a.id, 'REMOVE', { note: 'gone' }, F.admin)
    await expect(svc.reply('product', a.id, 'late reply', F.admin)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('reports: only published reviews, not your own, once per person; they flag the review and a decision clears the flag', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 1, 'Scam seller!!')
    const reporter = await mkUser('Reporter')
    await expect(reviews.reportReview(reporter, 'PRODUCT', a.id, 'abusive')).rejects.toMatchObject({ statusCode: 404 }) // not published yet
    await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin)
    await expect(reviews.reportReview(a.uid, 'PRODUCT', a.id, 'my own')).rejects.toMatchObject({ statusCode: 400 })
    await expect(reviews.reportReview(reporter, 'PRODUCT', a.id, 'x')).rejects.toMatchObject({ statusCode: 400 }) // reason too short
    await reviews.reportReview(reporter, 'PRODUCT', a.id, 'Abusive language')
    await reviews.reportReview(reporter, 'PRODUCT', a.id, 'Abusive language again') // same person: no second report
    const other = await mkUser('Reporter 2')
    await reviews.reportReview(other, 'PRODUCT', a.id, 'Fake review')

    const one = await svc.get('product', a.id)
    expect(one).toMatchObject({ flagged: true, flag_reason: 'Abusive language', report_count: 2 })
    expect(one.reports).toHaveLength(2)
    const flagged = await svc.list('product', { flagged: 'true', search: 'Scam seller' })
    expect(flagged.data.map((x) => x.id)).toContain(a.id)
    expect((await svc.list('product', { reported: 'true' })).data.map((x) => x.id)).toContain(a.id)

    const kept = await svc.moderate('product', a.id, 'PUBLISH', {}, F.admin).catch((e) => e)
    expect(kept).toMatchObject({ statusCode: 409 }) // already published
    await svc.moderate('product', a.id, 'HIDE', { note: 'upheld' }, F.admin)
    expect((await svc.get('product', a.id)).flagged).toBe(false)

    // an admin can flag by hand too (reason required)
    await expect(svc.flag('product', a.id, { flagged: true, reason: '' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    expect((await svc.flag('product', a.id, { flagged: true, reason: 'check order history' })).flagged).toBe(true)
    expect((await svc.flag('product', a.id, { flagged: false })).flagged).toBe(false)
  })

  it('vendor reviews: need a delivered order from that vendor, once per order, and feed the seller rating when published', async () => {
    const customer = await mkUser('Vendor Reviewer')
    const pid = await mkProduct()
    const inTransit = await mkDelivered(customer, pid, { status: 'SHIPPED', sellerStatus: 'SHIPPED' })
    await expect(reviews.createVendorReview(customer, { vendorId: F.vendor.id, orderId: inTransit, rating: 5 })).rejects.toMatchObject({ statusCode: 400 })

    const orderId = await mkDelivered(customer, pid)
    const stranger = await mkUser('Not the buyer')
    await expect(reviews.createVendorReview(stranger, { vendorId: F.vendor.id, orderId, rating: 5 })).rejects.toMatchObject({ statusCode: 400 })
    await expect(reviews.createVendorReview(customer, { vendorId: F.vendor.id, orderId, rating: 6 })).rejects.toMatchObject({ statusCode: 400 })

    const v1 = await reviews.createVendorReview(customer, { vendorId: F.vendor.id, orderId, rating: 4, comment: 'Quick dispatch' })
    expect(v1.status).toBe('SUBMITTED')
    await expect(reviews.createVendorReview(customer, { vendorId: F.vendor.id, orderId, rating: 5 })).rejects.toMatchObject({ statusCode: 400 })
    expect((await reviews.getVendorReviews(F.vendor.id, { page: 1, limit: 10 })).reviews).toHaveLength(0)
    expect((await q(`SELECT review_count FROM vendors WHERE id = $1`, [F.vendor.id])).rows[0].review_count).toBe(0)
    expect(await reviews.getVendorReviewsByOrder(customer, orderId)).toMatchObject([{ status: 'SUBMITTED', rating: 4 }])

    // a second delivered order from the same vendor
    const customer2 = await mkUser('Vendor Reviewer 2')
    const v2 = await reviews.createVendorReview(customer2, { vendorId: F.vendor.id, orderId: await mkDelivered(customer2, pid), rating: 2 })

    await svc.moderate('vendor', v1.id, 'PUBLISH', {}, F.admin)
    let vendor = (await q(`SELECT avg_rating, review_count FROM vendors WHERE id = $1`, [F.vendor.id])).rows[0]
    expect(vendor).toMatchObject({ avg_rating: '4.00', review_count: 1 })
    await svc.moderate('vendor', v2.id, 'PUBLISH', {}, F.admin)
    vendor = (await q(`SELECT avg_rating, review_count FROM vendors WHERE id = $1`, [F.vendor.id])).rows[0]
    expect(vendor).toMatchObject({ avg_rating: '3.00', review_count: 2 })
    expect((await q(`SELECT seller_rating, rating_count FROM shops WHERE id = $1`, [F.shop.id])).rows[0]).toMatchObject({ seller_rating: '3.00', rating_count: 2 })
    const pub = await reviews.getVendorReviews(F.vendor.id, { page: 1, limit: 10 })
    expect(pub.reviews).toHaveLength(2)
    expect(pub.averageRating).toBe(3)

    await svc.moderate('vendor', v2.id, 'REMOVE', { note: 'fake' }, F.admin)
    expect((await q(`SELECT avg_rating, review_count FROM vendors WHERE id = $1`, [F.vendor.id])).rows[0]).toMatchObject({ avg_rating: '4.00', review_count: 1 })

    // vendor reviews are reportable too, and they stay out of the product list
    const reporter = await mkUser('Vendor reporter')
    await reviews.reportReview(reporter, 'VENDOR', v1.id, 'Competitor review')
    expect((await svc.list('vendor', { flagged: 'true' })).data.map((x) => x.id)).toContain(v1.id)
    expect((await svc.list('product', { search: 'Quick dispatch' })).data).toHaveLength(0)
  })

  it('bulk moderation reports each failure on its own', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 5)
    const b = await submit(pid, 4)
    await svc.moderate('product', b.id, 'REJECT', { note: 'dup' }, F.admin)
    const res = await svc.bulk('product', [a.id, b.id, a.id, '00000000-0000-0000-0000-000000000000'], 'PUBLISH', {}, F.admin)
    expect(res.done).toEqual([a.id])
    expect(res.failed.map((f) => f.id).sort()).toEqual([b.id, '00000000-0000-0000-0000-000000000000'].sort())
    await expect(svc.bulk('product', [], 'PUBLISH')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await rating(pid)).rating_count).toBe(1)
  })

  it('list filters and the summary reflect the queue', async () => {
    const pid = await mkProduct()
    const needle = 'Needle ' + rand()
    const a = await submit(pid, 1, needle + ' in a haystack')
    const b = await submit(pid, 5, 'fine')
    await svc.moderate('product', b.id, 'PUBLISH', {}, F.admin)

    const pending = await svc.list('product', { status: 'submitted', search: needle })
    expect(pending.data).toHaveLength(1)
    expect(pending.data[0]).toMatchObject({ id: a.id, kind: 'PRODUCT', status: 'SUBMITTED', vendor_name: 'Review Vendor', subject_name: 'Review Phone' })
    expect((await svc.list('product', { vendorId: F.vendor.id, rating: 5, status: 'PUBLISHED' })).data.map((x) => x.id)).toContain(b.id)
    await expect(svc.list('product', { status: 'NOPE' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.list('product', { rating: 9 })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await svc.list('product', { limit: 1 })).pagination).toMatchObject({ page: 1, limit: 1 })

    const s = await svc.summary()
    expect(s.product.byStatus.SUBMITTED).toBeGreaterThanOrEqual(1)
    expect(s.product.pending).toBe(s.product.byStatus.SUBMITTED)
    expect(s.product.total).toBe(Object.values(s.product.byStatus).reduce((x, y) => x + y, 0))
    expect(s.settings.auto_publish).toBe(false)
    expect(s.vendor).toHaveProperty('byStatus')
  })

  it('other readers only count published reviews (admin top products, vendor timeline)', async () => {
    const pid = await mkProduct()
    const a = await submit(pid, 1)
    const b = await submit(pid, 5)
    await svc.moderate('product', b.id, 'PUBLISH', {}, F.admin)
    const { vendorTimeline } = await import('../../src/modules/subscriptions/vendor-timeline.service.js')
    const t = await vendorTimeline(F.vendor.id)
    const step = t.stages.find((s) => s.key === 'REVIEWS')
    const published = (await q(`SELECT COUNT(*)::int AS n FROM reviews r JOIN products p ON p.id = r.product_id WHERE p.owner_vendor_id = $1 AND r.status = 'PUBLISHED'`, [F.vendor.id])).rows[0].n
    expect(step.metrics.find((m) => m.label === 'Reviews').value).toBe(published)
    expect(a.status).toBe('SUBMITTED')
  })
})
