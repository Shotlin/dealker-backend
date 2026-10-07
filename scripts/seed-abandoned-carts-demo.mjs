/**
 * Demo data for the Abandoned Carts dashboard: realistic episodes in every
 * state (OPEN / RECOVERED / CONVERTED / EXPIRED) with item snapshots taken
 * from real catalogue products, repeat abandoners (history), reminders that
 * were sent and individually-targeted recovery coupons.
 *
 * Idempotent: exits early when the demo marker coupons already exist.
 * Run:  docker compose exec api node scripts/seed-abandoned-carts-demo.mjs
 */
import 'dotenv/config'
import pg from 'pg'
import crypto from 'node:crypto'
import { computeRecoveryPriorityScore } from '../src/modules/abandoned-carts/priority-score.js'

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

let seed = 424242
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const minutesAgo = (m) => new Date(Date.now() - m * 60000)
const round2 = (n) => Math.round(n * 100) / 100

const c = await pool.connect()
try {
  const { rows: marker } = await c.query(`SELECT 1 FROM coupons WHERE code LIKE 'DEMOCB%' LIMIT 1`)
  if (marker[0]) { console.log('Abandoned-cart demo data already present.'); process.exit(0) }

  const { rows: products } = await c.query(
    `SELECT sp.shop_id, sp.product_id, p.name, p.unit, p.thumbnail_url,
            COALESCE(NULLIF(sp.sale_price, 0), sp.price) AS unit_price, sp.price AS list_price
       FROM shop_products sp
       JOIN products p ON p.id = sp.product_id
      WHERE p.is_active AND sp.deleted_at IS NULL AND sp.stock_quantity > 0 AND sp.price > 0
      ORDER BY p.created_at DESC LIMIT 80`
  )
  const { rows: customers } = await c.query(
    `SELECT u.id, u.name FROM users u
      WHERE u.role = 'CUSTOMER' AND u.is_blocked = false AND u.name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM abandoned_carts a WHERE a.user_id = u.id AND a.status = 'OPEN')
      ORDER BY u.created_at LIMIT 16`
  )
  const { rows: [admin] } = await c.query(`SELECT id FROM users WHERE email = 'superadmin@dealker.local' LIMIT 1`)
  if (!products.length || customers.length < 8) throw new Error('Need catalogue products and at least 8 customers')

  // [status, minutesAgo, reminders, couponPreset|null]
  const plan = [
    ['OPEN', 4, 0, null], ['OPEN', 18, 0, null], ['OPEN', 55, 1, null], ['OPEN', 140, 1, 'PERCENT_10'],
    ['OPEN', 360, 2, 'FLAT_100'], ['OPEN', 900, 1, null], ['OPEN', 1900, 2, 'PERCENT_5'],
    ['RECOVERED', 300, 1, 'PERCENT_10'], ['RECOVERED', 1500, 1, null],
    ['CONVERTED', 600, 1, 'FLAT_50'], ['CONVERTED', 2200, 2, 'PERCENT_10'], ['EXPIRED', 9000, 1, null],
  ]
  const presets = {
    PERCENT_5: ['PERCENTAGE', 5, 0], PERCENT_10: ['PERCENTAGE', 10, 499],
    FLAT_50: ['FLAT', 50, 299], FLAT_100: ['FLAT', 100, 699],
  }

  const pickItems = () => {
    const n = int(1, 4), used = new Set(), items = []
    while (items.length < n) {
      const p = products[int(0, products.length - 1)]
      if (used.has(p.product_id + p.shop_id)) continue
      used.add(p.product_id + p.shop_id)
      const qty = int(1, 2)
      const price = Number(p.unit_price)
      items.push({ ...p, qty, price, list: Number(p.list_price), line: round2(price * qty) })
    }
    return items
  }

  async function createEpisode(user, status, ageMin, reminders, preset, { past = false } = {}) {
    const items = pickItems()
    const value = round2(items.reduce((s, i) => s + i.line, 0))
    const abandonedAt = minutesAgo(ageMin)
    const { rows: [ltvRow] } = await c.query(
      `SELECT COALESCE(SUM(total_payable),0) AS ltv FROM orders WHERE customer_id = $1 AND status = 'DELIVERED'`, [user.id])
    const score = computeRecoveryPriorityScore({
      cartValue: value, itemCount: items.length, ltv: Number(ltvRow.ltv),
      minutesSinceAbandonment: ageMin, recoveryRate: null,
    })
    const closedAt = status === 'OPEN' ? null : new Date(abandonedAt.getTime() + int(20, 240) * 60000)
    const { rows: [ep] } = await c.query(
      `INSERT INTO abandoned_carts
         (user_id, status, abandoned_at, detected_at, item_count, total_quantity, cart_value,
          priority_score, priority_breakdown, recovered_at, converted_at, expired_at,
          reminder_count, last_reminder_sent_at, created_at, updated_at)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$3,$3) RETURNING id`,
      [user.id, status, abandonedAt, items.length, items.reduce((s, i) => s + i.qty, 0), value,
        score.score, JSON.stringify(score.breakdown),
        status === 'RECOVERED' ? closedAt : null, status === 'CONVERTED' ? closedAt : null,
        status === 'EXPIRED' ? closedAt : null, reminders,
        reminders ? new Date(abandonedAt.getTime() + 25 * 60000) : null])
    for (const i of items) {
      await c.query(
        `INSERT INTO abandoned_cart_items (abandoned_cart_id, product_id, shop_id, product_name,
           product_thumbnail_url, product_unit, quantity, unit_price, list_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ep.id, i.product_id, i.shop_id, i.name, i.thumbnail_url, i.unit, i.qty, i.price, i.list, i.line])
    }
    const ev = (type, actor, at, meta = {}, actorId = null) => c.query(
      `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`, [ep.id, type, actor, actorId, JSON.stringify(meta), at])
    await ev('DETECTED', 'SYSTEM', abandonedAt)

    for (let r = 0; r < reminders; r++) {
      const at = new Date(abandonedAt.getTime() + (25 + r * 120) * 60000)
      const title = r === 0 ? `${(user.name || 'there').split(' ')[0]}, you left something behind` : 'Still thinking it over?'
      const body = `Your ${items.length} item(s) worth ₹${value.toLocaleString('en-IN')} are waiting in your cart.`
      const { rows: [n] } = await c.query(
        `INSERT INTO notifications (user_id, title, body, type, data, created_at)
         VALUES ($1,$2,$3,'abandoned_cart',$4,$5) RETURNING id`,
        [user.id, title, body, JSON.stringify({ abandonedCartId: ep.id, deepLink: '/cart' }), at])
      await c.query(
        `INSERT INTO abandoned_cart_notifications (abandoned_cart_id, notification_id, sent_by, created_at)
         VALUES ($1,$2,$3,$4)`, [ep.id, n.id, admin?.id ?? null, at])
      await ev('REMINDER_SENT', 'ADMIN', at, {}, admin?.id ?? null)
    }
    if (preset) {
      const [type, val, min] = presets[preset]
      const at = new Date(abandonedAt.getTime() + 60 * 60000)
      const code = `DEMOCB${crypto.randomBytes(3).toString('hex').toUpperCase()}`
      const { rows: [cp] } = await c.query(
        `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount,
           usage_limit, per_user_limit, valid_from, valid_until, coupon_type, absorber, target_type, created_by)
         VALUES ($1,$2,$3,$4,$5,1,1,$6,$7,'PLATFORM_COUPON','PLATFORM','INDIVIDUAL',$8) RETURNING id`,
        [code, `Cart recovery: ${preset}`, type, val, min, at, new Date(at.getTime() + 48 * 3600000), admin?.id ?? null])
      await c.query(`INSERT INTO coupon_target_users (coupon_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cp.id, user.id])
      await c.query(
        `INSERT INTO abandoned_cart_coupons (abandoned_cart_id, coupon_id, issued_by, created_at) VALUES ($1,$2,$3,$4)`,
        [ep.id, cp.id, admin?.id ?? null, at])
      await ev('COUPON_ISSUED', 'ADMIN', at, { couponId: cp.id }, admin?.id ?? null)
    }
    if (status === 'RECOVERED') await ev('RECOVERED', 'CUSTOMER', closedAt, {}, user.id)
    if (status === 'CONVERTED') await ev('CONVERTED', 'CUSTOMER', closedAt, {}, user.id)
    if (status === 'EXPIRED') await ev('EXPIRED', 'SYSTEM', closedAt)
    return ep.id
  }

  await c.query('BEGIN')
  let k = 0
  for (const [status, age, reminders, preset] of plan) {
    await createEpisode(customers[k % customers.length], status, age, reminders, preset)
    k++
  }
  // Repeat abandoners: older closed episodes for the first customers so "Cart History" has content.
  for (const [idx, history] of [[0, [['EXPIRED', 6200], ['RECOVERED', 4100]]], [2, [['CONVERTED', 3300]]], [3, [['EXPIRED', 7600], ['EXPIRED', 5100], ['RECOVERED', 2900]]]]) {
    for (const [st, age] of history) await createEpisode(customers[idx], st, age, st === 'EXPIRED' ? 0 : 1, null)
  }
  await c.query('COMMIT')
  const { rows: [sum] } = await c.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status='OPEN')::int AS open FROM abandoned_carts`)
  console.log(`✅ Abandoned-cart demo seeded: ${sum.n} episodes (${sum.open} open).`)
} catch (e) {
  await c.query('ROLLBACK').catch(() => {})
  console.error('Seed failed:', e.message)
  process.exitCode = 1
} finally {
  c.release()
  await pool.end()
}
