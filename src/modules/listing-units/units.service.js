import { query, getClient } from '../../config/database.js'
import { QcError, chipsOf, defectsOf, normalizeQc, reportOf, scoreOf } from './units.qc.js'

export { QcError }
const err = (status, message, code) => Object.assign(new Error(message), { statusCode: status, code })

/** Insert one QC report per unit (inside the caller's transaction). */
export async function createUnits(client, shopProductId, qcList, { imeis = [], actorId = null, startAt = 1 } = {}) {
  let n = startAt
  for (const [i, raw] of qcList.entries()) {
    let qc
    try { qc = normalizeQc(raw, n) } catch (e) { if (e instanceof QcError) throw err(400, e.message, 'QC_INCOMPLETE'); throw e }
    await client.query(
      `INSERT INTO listing_units (shop_product_id, unit_no, imei, qc, qc_score, battery_health, defects, checked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [shopProductId, n, imeis[i] || null, JSON.stringify(qc), scoreOf(qc), qc.battery.health, defectsOf(qc), actorId])
    n++
  }
}

/** All devices of a listing in order, with their state. */
export async function unitsOf(shopProductId) {
  const { rows } = await query(
    `SELECT u.unit_no, u.imei, u.qc, u.qc_score, u.battery_health, u.defects, u.checked_at, u.auto_filled, u.status, u.b2b_order_id, u.packed_at
       FROM listing_units u WHERE u.shop_product_id = $1 ORDER BY u.unit_no`, [shopProductId])
  return rows.map((r) => ({ ...r, sold: r.status !== 'AVAILABLE' }))
}

const brief = (u) => ({
  unit_no: u.unit_no, status: u.status, score: u.qc_score, battery_health: u.battery_health, defects: u.defects, chips: chipsOf(u.qc), checked_at: u.checked_at,
  auto_filled: !!u.auto_filled,
})

/** Vendor view of their own listing's devices (every state). */
export async function vendorUnits(shopProductId) {
  await ensureUnits(shopProductId)
  return (await unitsOf(shopProductId)).map((u) => ({ ...brief(u), imei: u.imei }))
}

/** Replace the QC of one device (vendor edits it). */
export async function updateUnit(shopProductId, unitNo, rawQc, actorId) {
  let qc
  try { qc = normalizeQc(rawQc, unitNo) } catch (e) { if (e instanceof QcError) throw err(400, e.message, 'QC_INCOMPLETE'); throw e }
  const { rowCount } = await query(
    `UPDATE listing_units SET qc = $3, qc_score = $4, battery_health = $5, defects = $6, checked_by = $7, checked_at = NOW(), auto_filled = FALSE WHERE shop_product_id = $1 AND unit_no = $2`,
    [shopProductId, unitNo, JSON.stringify(qc), scoreOf(qc), qc.battery.health, defectsOf(qc), actorId])
  if (!rowCount) throw err(404, 'Device not found', 'NOT_FOUND')
  return { ok: true }
}

async function listingOf(productId) {
  const { rows } = await query(
    `SELECT sp.id FROM shop_products sp WHERE sp.product_id = $1 AND sp.deleted_at IS NULL AND sp.approval_status = 'APPROVED'
      ORDER BY sp.created_at DESC LIMIT 1`, [productId])
  return rows[0]?.id || null
}

/**
 * Public: devices of a product, paged, in device order (Device 1, 2, …). Unavailable ones (reserved / packed / sold) are
 * included so the app can show them blurred; `available_count` is what can still be bought.
 */
export async function listUnits(productId, { offset = 0, limit = 30 } = {}) {
  const spId = await listingOf(productId)
  if (!spId) return { total: 0, available_count: 0, items: [] }
  await releaseStale()
  await ensureUnits(spId)
  const lim = Math.min(100, Math.max(1, Number(limit) || 30)), off = Math.max(0, Number(offset) || 0)
  const { rows: c } = await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'AVAILABLE')::int AS avail FROM listing_units WHERE shop_product_id = $1`, [spId])
  const { rows } = await query(
    `SELECT unit_no, qc, qc_score, battery_health, defects, checked_at, auto_filled, status FROM listing_units
      WHERE shop_product_id = $1 ORDER BY unit_no OFFSET $2 LIMIT $3`, [spId, off, lim])
  return { total: c[0].total, available_count: c[0].avail, offset: off, items: rows.map((u) => brief(u)) }
}

/** The first N available device numbers (what the buyer gets by default for quantity N). */
export async function firstAvailable(productId, n) {
  const spId = await listingOf(productId)
  if (!spId) return []
  await releaseStale()
  await ensureUnits(spId)
  const { rows } = await query(`SELECT unit_no FROM listing_units WHERE shop_product_id = $1 AND status = 'AVAILABLE' ORDER BY unit_no LIMIT $2`, [spId, Math.min(500, Number(n) || 1)])
  return rows.map((r) => r.unit_no)
}

/** Full report of one device by its number. */
export async function unitReport(productId, unitNo) {
  const spId = await listingOf(productId)
  if (!spId) throw err(404, 'Not found', 'NOT_FOUND')
  await ensureUnits(spId)
  const { rows } = await query(`SELECT unit_no, qc, qc_score, battery_health, defects, checked_at, auto_filled, status FROM listing_units WHERE shop_product_id = $1 AND unit_no = $2`, [spId, Number(unitNo)])
  const u = rows[0]
  if (!u) throw err(404, 'Device not found', 'NOT_FOUND')
  return { ...brief(u), report: { ...reportOf(u.qc), ...(u.auto_filled ? { auto_note: 'Based on the seller’s listing details — this device has not been inspected one by one yet.' } : {}) } }
}

/** The first available device's QC as the flat checks the customer product page already renders. */
export async function firstUnitAsQc(productId) {
  const spId = await listingOf(productId)
  if (!spId) return null
  await ensureUnits(spId)
  const first = (await unitsOf(spId)).find((u) => u.status === 'AVAILABLE')
  if (!first) return null
  const rep = reportOf(first.qc)
  const checks = [...rep.screen, ...rep.battery, ...rep.physical, ...rep.functional.filter((f) => f.ok !== null)]
    .map((c) => ({ label: c.label, value: c.value, ok: c.ok === true }))
  return { status: 'QC_PASSED', score: first.qc_score, checkedAt: first.checked_at, condition: null, unit: `Device ${first.unit_no}`, autoFilled: !!first.auto_filled, checks }
}

// ── Default QC for listings that have none (older listings, bulk uploads, stock increases) ──────────────

const BATTERY_DEFAULT = { REFURBISHED: 92, OPEN_BOX: 100, USED_LIKE_NEW: 92, USED_GOOD: 87, USED_FAIR: 80 }
const PHONE_FUNCS = ['touch', 'wifi', 'bluetooth', 'gps', 'cameras', 'speaker', 'microphone', 'biometric', 'volume_buttons', 'power_button', 'charging_port', 'vibrator', 'proximity_sensor', 'sim_tray', 'audio_jack']

/** A sensible QC for a device we only know from its listing: condition, battery and the vendor's old checklist. */
export function defaultQc({ condition, batteryHealth, vendorQc, productType }) {
  const cl = vendorQc?.checklist && typeof vendorQc.checklist === 'object' ? vendorQc.checklist : {}
  const isPhone = ['mobile', 'tablet', 'laptop', undefined, null, ''].includes(productType)
  const level = { REFURBISHED: 0, OPEN_BOX: 0, USED_LIKE_NEW: 0, USED_GOOD: 1, USED_FAIR: 2 }[condition] ?? 0
  const bodyBy = { Excellent: 'LIKE_NEW', Good: 'GOOD', Fair: 'FAIR', Damaged: 'DENTED' }[cl['Body Condition']]
  const body = bodyBy || ['LIKE_NEW', 'GOOD', 'FAIR'][level]
  const screenCl = cl['Screen Display']
  const functional = {}
  for (const k of PHONE_FUNCS) functional[k] = isPhone && k !== 'audio_jack' ? 'PASS' : 'NA'
  const fail = (keys) => keys.forEach((k) => { if (functional[k] === 'PASS') functional[k] = 'FAIL' })
  if (cl['Touch Function'] === 'Not working') fail(['touch'])
  if (cl.Camera === 'Not working') fail(['cameras'])
  if (cl.Buttons === 'Not working') fail(['volume_buttons', 'power_button'])
  if (cl['Speaker & Mic'] === 'Not working') fail(['speaker', 'microphone'])
  const b = Number(batteryHealth)
  return {
    battery: { health: Number.isInteger(b) && b >= 40 && b <= 100 ? b : BATTERY_DEFAULT[condition] || 90 },
    screen: {
      lcd: screenCl === 'Not working' ? 'DEFECTIVE' : screenCl === 'Minor issue' ? 'MINOR_DEFECT' : 'WORKING',
      condition: screenCl === 'Not working' ? 'CRACKED' : screenCl === 'Minor issue' ? 'MINOR_SCRATCHES' : ['FLAWLESS', 'MINOR_SCRATCHES', 'VISIBLE_SCRATCHES'][level],
    },
    physical: { body, back: body, frame: body === 'DENTED' ? 'SCUFFED' : level === 2 ? 'SCUFFED' : 'STRAIGHT' },
    functional,
  }
}

/**
 * Keeps the devices of a non-new listing in step with its stock: more stock than AVAILABLE devices → add default devices
 * (flagged auto_filled); less stock (units sold through other channels) → the lowest available devices become SOLD.
 */
export async function ensureUnits(shopProductId) {
  const { rows } = await query(
    `SELECT sp.stock_quantity AS stock, p.condition, p.battery_health, sp.vendor_qc, p.specifications->>'product_type' AS product_type,
            (SELECT COALESCE(MAX(unit_no), 0) FROM listing_units u WHERE u.shop_product_id = sp.id) AS maxno,
            (SELECT COUNT(*) FROM listing_units u WHERE u.shop_product_id = sp.id AND u.status = 'AVAILABLE') AS avail
       FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE sp.id = $1 AND sp.deleted_at IS NULL`, [shopProductId])
  const r = rows[0]
  if (!r || r.condition === 'NEW' || !r.condition) return 0
  const stock = Math.min(Number(r.stock), 2000), avail = Number(r.avail)
  if (stock < avail) {
    await query(
      `UPDATE listing_units SET status = 'SOLD' WHERE shop_product_id = $1 AND unit_no IN
         (SELECT unit_no FROM listing_units WHERE shop_product_id = $1 AND status = 'AVAILABLE' ORDER BY unit_no LIMIT $2)`, [shopProductId, avail - stock])
    return 0
  }
  const need = stock - avail
  if (need <= 0) return 0
  const base = defaultQc({ condition: r.condition, batteryHealth: r.battery_health, vendorQc: r.vendor_qc, productType: r.product_type })
  const qc = normalizeQc(base)
  await query(
    `INSERT INTO listing_units (shop_product_id, unit_no, qc, qc_score, battery_health, defects, auto_filled)
     SELECT $1, g, $2::jsonb, $3, $4, $5, TRUE FROM generate_series($6::int + 1, $6::int + $7::int) g
     ON CONFLICT (shop_product_id, unit_no) DO NOTHING`,
    [shopProductId, JSON.stringify(qc), scoreOf(qc), qc.battery.health, defectsOf(qc), Number(r.maxno), need])
  return need
}

// ── Device reservations for B2B orders ──────────────────────────────────

/**
 * Reserve [unitNos] (or the first [qty] available) of a listing for an order, inside [client]'s transaction.
 * Stock goes down by the devices taken. Returns the reserved device numbers.
 */
export async function reserveUnits(client, shopProductId, qty, unitNos = null) {
  await ensureUnits(shopProductId)
  let nos
  if (Array.isArray(unitNos) && unitNos.length) {
    nos = [...new Set(unitNos.map(Number))]
    if (nos.length !== qty || nos.some((n) => !Number.isInteger(n) || n < 1)) throw err(400, `Select exactly ${qty} device${qty === 1 ? '' : 's'}`, 'DEVICE_SELECTION')
  }
  const { rows } = nos
    ? await client.query(`SELECT unit_no FROM listing_units WHERE shop_product_id = $1 AND unit_no = ANY($2) AND status = 'AVAILABLE' ORDER BY unit_no FOR UPDATE`, [shopProductId, nos])
    : await client.query(`SELECT unit_no FROM listing_units WHERE shop_product_id = $1 AND status = 'AVAILABLE' ORDER BY unit_no LIMIT $2 FOR UPDATE`, [shopProductId, qty])
  if (rows.length !== qty) throw err(409, nos ? 'Some of the devices you chose were just taken — please choose again' : 'Not enough devices are available', 'DEVICES_TAKEN')
  const got = rows.map((r) => r.unit_no)
  await client.query(`UPDATE listing_units SET status = 'RESERVED', reserved_at = NOW() WHERE shop_product_id = $1 AND unit_no = ANY($2)`, [shopProductId, got])
  await client.query(`UPDATE shop_products SET stock_quantity = GREATEST(0, stock_quantity - $2), updated_at = NOW() WHERE id = $1`, [shopProductId, qty])
  return got
}

export async function attachOrder(client, shopProductId, unitNos, orderId) {
  await client.query(`UPDATE listing_units SET b2b_order_id = $3 WHERE shop_product_id = $1 AND unit_no = ANY($2)`, [shopProductId, unitNos, orderId])
}

/** Put specific devices back on sale (a purchase failed before an order existed). */
export async function releaseNos(shopProductId, nos) {
  const { rowCount } = await query(`UPDATE listing_units SET status = 'AVAILABLE', reserved_at = NULL WHERE shop_product_id = $1 AND unit_no = ANY($2) AND status = 'RESERVED' AND b2b_order_id IS NULL`, [shopProductId, nos])
  if (rowCount) await query(`UPDATE shop_products SET stock_quantity = stock_quantity + $2, updated_at = NOW() WHERE id = $1`, [shopProductId, rowCount])
}

/** Put an order's devices back on sale (order cancelled / unpaid too long). */
export async function releaseForOrder(client, orderId) {
  const { rows } = await client.query(
    `UPDATE listing_units SET status = 'AVAILABLE', b2b_order_id = NULL, reserved_at = NULL, packed_at = NULL
      WHERE b2b_order_id = $1 AND status IN ('RESERVED', 'PACKED') RETURNING shop_product_id`, [orderId])
  const per = {}
  for (const r of rows) per[r.shop_product_id] = (per[r.shop_product_id] || 0) + 1
  for (const [sp, n] of Object.entries(per)) await client.query(`UPDATE shop_products SET stock_quantity = stock_quantity + $2, updated_at = NOW() WHERE id = $1`, [sp, n])
  return rows.length
}

/** Order moved on: PACKED/DISPATCHED → devices packed, DELIVERED → sold. */
export async function setOrderUnits(client, orderId, status) {
  if (status === 'DELIVERED') await client.query(`UPDATE listing_units SET status = 'SOLD' WHERE b2b_order_id = $1`, [orderId])
  else await client.query(`UPDATE listing_units SET status = 'PACKED', packed_at = COALESCE(packed_at, NOW()) WHERE b2b_order_id = $1 AND status = 'RESERVED'`, [orderId])
}

/** The seller marks one device of a paid order as packed. */
export async function markPacked(orderId, sellerVendorId, unitNo, packed = true) {
  const { rows } = await query(
    `SELECT o.status, o.seller_vendor_id FROM b2b_orders o WHERE o.id = $1`, [orderId])
  const o = rows[0]
  if (!o || o.seller_vendor_id !== sellerVendorId) throw err(404, 'Order not found', 'NOT_FOUND')
  if (!['PAID', 'PACKED'].includes(o.status)) throw err(409, 'The buyer must pay before you pack', 'INVALID_TRANSITION')
  const { rowCount } = await query(
    `UPDATE listing_units SET status = $4, packed_at = ${packed ? 'NOW()' : 'NULL'} WHERE b2b_order_id = $1 AND unit_no = $2 AND status = $3`,
    [orderId, Number(unitNo), packed ? 'RESERVED' : 'PACKED', packed ? 'PACKED' : 'RESERVED'])
  if (!rowCount) throw err(404, 'Device not found in this order', 'NOT_FOUND')
  return { ok: true }
}

/** Devices of an order (for the buyer and the seller): number, state, score and the product they belong to. */
export async function orderUnits(orderId) {
  const { rows } = await query(
    `SELECT u.unit_no, u.status, u.qc_score, u.defects, u.battery_health, u.packed_at, u.qc, p.name, p.id AS product_id
       FROM listing_units u JOIN shop_products sp ON sp.id = u.shop_product_id JOIN products p ON p.id = sp.product_id
      WHERE u.b2b_order_id = $1 ORDER BY u.unit_no`, [orderId])
  return rows.map((u) => ({ unit_no: u.unit_no, status: u.status, score: u.qc_score, defects: u.defects, battery_health: u.battery_health, packed_at: u.packed_at, chips: chipsOf(u.qc), product_id: u.product_id, product_name: u.name }))
}

/** Unpaid reservations older than 45 minutes are released and their order cancelled. */
let lastRelease = 0
export async function releaseStale() {
  if (Date.now() - lastRelease < 60000) return
  lastRelease = Date.now()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT DISTINCT o.id, o.requirement_id FROM listing_units u JOIN b2b_orders o ON o.id = u.b2b_order_id
        WHERE u.status = 'RESERVED' AND u.reserved_at < NOW() - INTERVAL '45 minutes' AND o.status = 'PENDING_PAYMENT'`)
    for (const o of rows) {
      await releaseForOrder(client, o.id)
      await client.query(`UPDATE b2b_orders SET status = 'CANCELLED', cancel_reason = 'Payment not completed in time', updated_at = NOW() WHERE id = $1`, [o.id])
      await client.query(`UPDATE b2b_requirements SET status = 'CANCELLED', cancel_reason = 'Payment not completed in time', updated_at = NOW() WHERE id = $1 AND status IN ('OPEN','AWARDED')`, [o.requirement_id])
    }
    await client.query('COMMIT')
  } catch { await client.query('ROLLBACK').catch(() => {}) } finally { client.release() }
}

/** Every vendor's non-new listing → default devices. Returns per-vendor counts. */
export async function backfillAll() {
  const { rows } = await query(
    `SELECT sp.id, COALESCE(v.name, 'Platform') AS vendor FROM shop_products sp JOIN products p ON p.id = sp.product_id LEFT JOIN vendors v ON v.id = p.owner_vendor_id
      WHERE sp.deleted_at IS NULL AND p.deleted_at IS NULL AND p.condition IS NOT NULL AND p.condition <> 'NEW' AND sp.stock_quantity > 0`)
  const out = {}
  for (const r of rows) {
    const n = await ensureUnits(r.id)
    if (n) { out[r.vendor] ??= { listings: 0, devices: 0 }; out[r.vendor].listings++; out[r.vendor].devices += n }
  }
  return out
}
