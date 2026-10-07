// Enriches demo orders with what the dedicated order page shows: vendor invoices, packing proof (photos + video),
// points/wallet usage and cashback. Idempotent.
import 'dotenv/config'
import pg from 'pg'
const pool = new pg.Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD })
const c = await pool.connect()
try {
  await c.query('BEGIN')
  if ((await c.query(`SELECT 1 FROM seller_order_media LIMIT 1`)).rows[0]) { console.log('already enriched'); process.exit(0) }
  const VIDEO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
  const sos = (await c.query(`SELECT id, seller_order_number, status, created_at, shipped_at FROM seller_orders WHERE status NOT IN ('CANCELLED') ORDER BY created_at`)).rows
  let i = 0, media = 0
  for (const so of sos) {
    i++
    await c.query(`UPDATE seller_orders SET invoice_number = $2 WHERE id = $1`, [so.id, `VINV-${so.seller_order_number.replace(/^MK-/, '')}`])
    if (['ORDER_PLACED', 'CONFIRMED'].includes(so.status)) continue
    const base = new Date(new Date(so.created_at).getTime() + 3 * 3600000)
    const seed = so.id.slice(0, 8)
    const photos = ['Item with all accessories', 'Item sealed in packing', 'Parcel with shipping label']
    for (const [k, cap] of photos.entries())
      await c.query(`INSERT INTO seller_order_media (seller_order_id, kind, url, caption, created_at) VALUES ($1,'IMAGE',$2,$3,$4)`, [so.id, `https://picsum.photos/seed/pack-${seed}-${k}/640/480`, cap, new Date(base.getTime() + k * 120000)]), media++
    if (i % 3 !== 0) { await c.query(`INSERT INTO seller_order_media (seller_order_id, kind, url, caption, created_at) VALUES ($1,'VIDEO',$2,'Packing video',$3)`, [so.id, VIDEO, new Date(base.getTime() + 600000)]); media++ }
  }
  // points / wallet usage
  await c.query(`UPDATE orders SET points_redeemed = 150, loyalty_redeemed_amount = 150 WHERE payment_status = 'PAID' AND abs(hashtext(id::text)) % 4 = 0 AND total_payable > 600`)
  await c.query(`UPDATE orders SET wallet_amount = 100 WHERE payment_status = 'PAID' AND abs(hashtext(id::text)) % 7 = 0 AND total_payable > 600`)
  // cashback on a share of delivered orders
  const cb = await c.query(
    `INSERT INTO cashback_transactions (source_type, order_id, user_id, amount, credit_trigger, status, created_at, credited_at)
     SELECT 'COUPON', o.id, o.customer_id, GREATEST(round(o.total_payable * 0.02), 5), 'ORDER_DELIVERED', 'CREDITED', o.delivered_at, o.delivered_at
       FROM orders o WHERE o.status = 'DELIVERED' AND o.delivered_at IS NOT NULL AND (o.coupon_code IS NOT NULL OR abs(hashtext(o.id::text)) % 5 = 0)`)
  await c.query('COMMIT')
  console.log(`✅ invoices for ${sos.length} seller orders, ${media} proof files, ${cb.rowCount} cashback credits`)
} catch (e) { await c.query('ROLLBACK'); console.error(e.message); process.exitCode = 1 } finally { c.release(); await pool.end() }
