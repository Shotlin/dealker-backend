// One-off manual demo-data script (not wired to any npm alias — run
// directly via `node scripts/seed_review_threshold_demo.mjs`). Seeds
// DELIVERED orders + reviews for three staple products so the ">10 reviews
// shows the count, 10-or-fewer shows only the star" threshold on the
// product detail page can be visually validated against real data:
//   - Onion(Kanda)      -> 11 reviews (count SHOULD show)
//   - Tomato (Tameta)   -> 11 reviews (count SHOULD show)
//   - Potato (Bateta)   -> 9 reviews  (count should NOT show, star only)
//
// Reviewers are a small set of DEDICATED fake demo accounts (created/
// upserted by this script itself, phone-prefixed 70000000xx) — never real
// registered customers. Attaching fabricated order/purchase history to an
// actual customer's account would be wrong regardless of how clearly the
// order is labeled as a demo internally.
//
// Idempotent: re-running tops a product up to its target count instead of
// piling on duplicates — each run only inserts however many more
// order+review pairs are needed to reach the target.
import 'dotenv/config'

import { getClient } from '../src/config/database.js'
import { cacheDeletePattern } from '../src/utils/cache.js'

const DAY_MS = 24 * 60 * 60 * 1000

const TARGETS = [
  { name: 'Onion(Kanda)', targetReviewCount: 11 },
  { name: 'Tomato (Tameta)', targetReviewCount: 11 },
  { name: 'Potato (Bateta)', targetReviewCount: 9 },
]

const DEMO_REVIEWER_NAMES = [
  'Demo Reviewer 1', 'Demo Reviewer 2', 'Demo Reviewer 3', 'Demo Reviewer 4',
  'Demo Reviewer 5', 'Demo Reviewer 6', 'Demo Reviewer 7', 'Demo Reviewer 8',
  'Demo Reviewer 9', 'Demo Reviewer 10', 'Demo Reviewer 11',
]

const COMMENTS = [
  'Fresh and good quality, delivered on time.',
  'Exactly as described, will order again.',
  'Good value for the price.',
  'Quality was decent, packaging could be better.',
  'Very fresh, my family loved it.',
  null, // some reviews are rating-only, no comment — matches real usage
]

const RATINGS = [5, 5, 4, 5, 4, 3, 5, 4, 5, 4, 5]

function buildAddress(customer, index) {
  return {
    name: customer.name || 'Bakaloo Customer',
    phone: customer.phone,
    line1: `${12 + index} Demo Lane`,
    line2: 'Near Local Market',
    landmark: 'Opposite Bus Stand',
    city: 'Kolkata',
    state: 'West Bengal',
    pincode: '700073',
    label: 'home',
  }
}

function buildTimestamps(offsetDays) {
  const baseTime = Date.now() - offsetDays * DAY_MS
  const createdAt = new Date(baseTime)
  const confirmedAt = new Date(baseTime + 10 * 60 * 1000)
  const outForDeliveryAt = new Date(baseTime + 60 * 60 * 1000)
  const deliveredAt = new Date(baseTime + 90 * 60 * 1000)
  const estimatedDelivery = new Date(baseTime + 100 * 60 * 1000)
  return { createdAt, confirmedAt, outForDeliveryAt, deliveredAt, estimatedDelivery }
}

async function createDeliveredOrderWithReview(client, { product, customer, adminId, reviewIndex, offsetDays }) {
  const times = buildTimestamps(offsetDays)
  const quantity = 1
  const unitPrice = Number(product.price)
  const subtotal = unitPrice * quantity
  const deliveryFee = 25
  const totalAmount = subtotal + deliveryFee
  const orderNumber = `REVDEMO${String(Date.now()).slice(-6)}${reviewIndex}`.slice(0, 20)

  const items = [
    {
      productId: product.id,
      name: product.name,
      price: unitPrice,
      quantity,
      unit: product.unit,
      total: subtotal,
    },
  ]

  const { rows } = await client.query(
    `INSERT INTO orders (
       order_number, user_id, status, items, subtotal, discount_amount,
       delivery_fee, platform_fee, tax_amount, total_amount, payment_method,
       payment_status, coupon_code, delivery_address, delivery_notes,
       estimated_delivery, delivered_at, created_at, updated_at
     ) VALUES (
       $1,$2,'DELIVERED',$3::jsonb,$4,0,$5,0,0,$6,'COD','PAID',NULL,$7::jsonb,$8,$9,$10,$11,$11
     )
     RETURNING id`,
    [
      orderNumber,
      customer.id,
      JSON.stringify(items),
      subtotal,
      deliveryFee,
      totalAmount,
      JSON.stringify(buildAddress(customer, reviewIndex)),
      'Review-threshold demo order.',
      times.estimatedDelivery,
      times.deliveredAt,
      times.createdAt,
    ]
  )
  const orderId = rows[0].id

  await client.query(
    `INSERT INTO order_items (order_id, product_id, name, price, quantity, unit, total, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orderId, product.id, product.name, unitPrice, quantity, product.unit, subtotal, times.createdAt]
  )

  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note, changed_at)
     VALUES
       ($1, NULL, 'PENDING', $2, 'Order created (review-threshold demo)', $3),
       ($1, 'PENDING', 'CONFIRMED', $2, 'Order confirmed by store', $4),
       ($1, 'CONFIRMED', 'OUT_FOR_DELIVERY', $2, 'Packed and assigned for delivery', $5),
       ($1, 'OUT_FOR_DELIVERY', 'DELIVERED', $2, 'Delivered successfully', $6)`,
    [orderId, adminId, times.createdAt, times.confirmedAt, times.outForDeliveryAt, times.deliveredAt]
  )

  await client.query(
    `INSERT INTO reviews (user_id, product_id, order_id, rating, comment, is_verified_purchase, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,$6)`,
    [
      customer.id,
      product.id,
      orderId,
      RATINGS[reviewIndex % RATINGS.length],
      COMMENTS[reviewIndex % COMMENTS.length],
      times.deliveredAt,
    ]
  )
}

// Creates (or reuses, if already run before) a fixed pool of dedicated fake
// reviewer accounts — phone-prefixed 70000000xx so they're unmistakably
// demo data, never a real registered customer's number.
async function ensureDemoReviewers(client) {
  const reviewers = []
  for (let i = 0; i < DEMO_REVIEWER_NAMES.length; i++) {
    const phone = `70000000${String(i + 1).padStart(2, '0')}`
    const { rows } = await client.query(
      `INSERT INTO users (phone, name, role, is_active)
       VALUES ($1, $2, 'CUSTOMER', true)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, phone`,
      [phone, DEMO_REVIEWER_NAMES[i]]
    )
    reviewers.push(rows[0])
  }
  return reviewers
}

async function recomputeProductRating(client, productId) {
  await client.query(
    `UPDATE products
        SET avg_rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE product_id = $1), 0),
            rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1)
      WHERE id = $1`,
    [productId]
  )
}

async function main() {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const { rows: admins } = await client.query(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`)
    if (admins.length === 0) {
      throw new Error('No ADMIN user found — cannot attribute order_status_history rows.')
    }
    const adminId = admins[0].id
    const demoReviewers = await ensureDemoReviewers(client)
    const touched = []

    for (const target of TARGETS) {
      const { rows: productRows } = await client.query(
        `SELECT id, name, price, unit FROM products WHERE is_active = true AND name = $1 LIMIT 1`,
        [target.name]
      )
      if (productRows.length === 0) {
        console.warn(`⚠️  Product "${target.name}" not found (active) — skipping.`)
        continue
      }
      const product = productRows[0]

      const { rows: countRows } = await client.query(
        'SELECT COUNT(*)::int AS count FROM reviews WHERE product_id = $1',
        [product.id]
      )
      const existingCount = countRows[0].count
      const needed = target.targetReviewCount - existingCount

      if (needed <= 0) {
        console.log(`✓ ${product.name} already has ${existingCount} reviews (target ${target.targetReviewCount}) — skipping.`)
        continue
      }

      // Dedicated demo reviewer pool only — excludes whichever of them
      // already reviewed this exact product (relevant on a re-run that
      // tops a product up further) so each demo account reviews a given
      // product at most once, same one-review-per-order-per-product spirit
      // as the real constraint.
      const { rows: reviewedAlready } = await client.query(
        'SELECT user_id FROM reviews WHERE product_id = $1',
        [product.id]
      )
      const reviewedIds = new Set(reviewedAlready.map((r) => r.user_id))
      const customers = demoReviewers.filter((r) => !reviewedIds.has(r.id)).slice(0, needed)
      if (customers.length < needed) {
        console.warn(
          `⚠️  Only found ${customers.length} eligible demo reviewers for ${product.name}, needed ${needed} — seeding what's available.`
        )
      }

      for (let i = 0; i < customers.length; i++) {
        await createDeliveredOrderWithReview(client, {
          product,
          customer: customers[i],
          adminId,
          reviewIndex: existingCount + i,
          offsetDays: 3 + i,
        })
      }

      await recomputeProductRating(client, product.id)

      const { rows: finalRows } = await client.query(
        'SELECT avg_rating, rating_count FROM products WHERE id = $1',
        [product.id]
      )
      touched.push({ product, seeded: customers.length, ...finalRows[0] })
    }

    await client.query('COMMIT')

    // Cache-bust only after the transaction actually commits — no point
    // invalidating a cache entry for writes that might still roll back.
    for (const { product } of touched) {
      await cacheDeletePattern(`products:detail:*:${product.id}`)
    }
    await cacheDeletePattern('products:list:*')
    await cacheDeletePattern('products:featured*')

    for (const { product, seeded, avg_rating, rating_count } of touched) {
      console.log(
        `✓ ${product.name}: seeded ${seeded} review(s), now avg_rating=${avg_rating} rating_count=${rating_count}`
      )
    }
    console.log('Done.')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
