/**
 * Demo LIVE auctions for the customer-app Home "Live Auction" strip.
 *
 *   npm run seed:auction-demo                 add 4 live auctions (skips products that already have an auction)
 *   npm run seed:auction-demo -- --count=5    add up to 5
 *   npm run seed:auction-demo -- --clear      remove ONLY the demo auctions
 *
 * Inside Docker:  docker compose exec api node src/database/seeds/auction-demo.js
 *
 * Everything goes through the real service (createAuction, then startNow if needed), so stock holds, events, numbering and
 * the live state are exactly what production produces. Products are picked from the in-stock catalogue, most
 * expensive first; each demo auction holds 1 unit of its product while it runs. Demo rows are tagged
 * auction_number 'AU-DEMO-…'; --clear cancels them (releasing the stock) and deletes the ones nobody touched.
 * No bids are placed, so the cards read "Starting Bid".
 */

const { query, pool } = await import('../../config/database.js')
const admin = await import('../../modules/auctions/auction-admin.service.js')

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const clear = process.argv.includes('--clear')
const COUNT = Math.min(8, Math.max(1, Number(arg('count') || 4)))
// Hours each demo auction runs for — staggered so the strip shows different countdowns.
const DURATIONS_H = [5, 11, 30, 52, 76, 100, 140, 200]
const LIVE_LIKE = ['PENDING_APPROVAL', 'SCHEDULED', 'LIVE', 'PAUSED', 'AWAITING_PAYMENT']

async function adminActor() {
  const { rows } = await query(`SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`)
  if (!rows[0]) throw new Error('No ADMIN user found — create the super admin first (scripts/seed-super-admin.mjs).')
  return { kind: 'ADMIN', userId: rows[0].id, vendorId: null }
}

async function clearDemo(actor) {
  const { rows } = await query(`SELECT id, status FROM auctions WHERE auction_number LIKE 'AU-DEMO-%'`)
  let removed = 0
  let kept = 0
  for (const a of rows) {
    if (LIVE_LIKE.includes(a.status)) await admin.cancel(actor, a.id, 'Demo data cleared')
    const { rows: touched } = await query(
      `SELECT (SELECT COUNT(*) FROM auction_registrations WHERE auction_id = $1)::int AS regs,
              (SELECT COUNT(*) FROM auction_bids WHERE auction_id = $1)::int AS bids`, [a.id])
    if (touched[0].regs === 0 && touched[0].bids === 0) {
      await query(`DELETE FROM auctions WHERE id = $1`, [a.id])
      removed += 1
    } else kept += 1
  }
  console.log(`Demo auctions removed: ${removed}${kept ? `, kept ${kept} (real bidders registered; left cancelled)` : ''}`)
}

const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step)

async function addDemo(actor) {
  const { rows: existing } = await query(`SELECT COUNT(*)::int AS n FROM auctions WHERE auction_number LIKE 'AU-DEMO-%' AND status = 'LIVE'`)
  const need = COUNT - existing[0].n
  if (need <= 0) {
    console.log(`Already ${existing[0].n} live demo auctions — nothing to add (use --clear first to start over).`)
    return
  }
  const { rows: products } = await query(
    `SELECT p.id, p.name, COALESCE(p.sale_price, p.price) AS price
       FROM products p
      WHERE p.is_active = TRUE AND p.thumbnail_url IS NOT NULL
        AND EXISTS (SELECT 1 FROM shop_products sp WHERE sp.product_id = p.id AND sp.deleted_at IS NULL AND sp.stock_quantity >= 1)
        AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.product_id = p.id AND a.status = ANY($1))
      ORDER BY COALESCE(p.sale_price, p.price) DESC
      LIMIT $2`, [LIVE_LIKE, need])
  if (!products.length) throw new Error('No in-stock product with a photo is free for an auction.')

  let n = existing[0].n
  for (const p of products) {
    const price = Number(p.price)
    const startPrice = roundTo(price * 0.45, 100)
    const reservePrice = roundTo(price * 0.8, 100)
    const registrationFee = Math.min(500, Math.max(10, Math.floor(startPrice * 0.01)))
    const bidIncrement = price >= 50000 ? 1000 : price >= 10000 ? 500 : price >= 2000 ? 100 : 50
    const created = await admin.createAuction(actor, {
      productId: p.id,
      startPrice, reservePrice, bidIncrement, registrationFee,
      durationHours: DURATIONS_H[n % DURATIONS_H.length],
    })
    n += 1
    const tag = `AU-DEMO-${String(n).padStart(3, '0')}`
    // Tag first so --clear can always find it, then make sure it is live (a start time of "now" goes live at creation).
    await query(`UPDATE auctions SET auction_number = $2 WHERE id = $1`, [created.id, tag])
    if (created.status === 'SCHEDULED') await admin.startNow(actor, created.id)
    console.log(`LIVE  ${tag}  ${p.name}  start ₹${startPrice}  reserve ₹${reservePrice}  ends in ${DURATIONS_H[(n - 1) % DURATIONS_H.length]}h`)
  }
}

try {
  const actor = await adminActor()
  if (clear) await clearDemo(actor)
  else await addDemo(actor)
} catch (err) {
  console.error('auction-demo failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
  process.exit(process.exitCode || 0)
}
