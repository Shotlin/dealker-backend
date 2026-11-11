/**
 * Exchange programs — which products can be bought with a trade-in, and which old devices are accepted.
 * The dashboard edits `exchange_device_types` and `exchange_programs`; the product page and the exchange
 * flow in the customer app only read them. Valuation itself stays in the shared sell engine.
 *
 * @module modules/sell-requests/exchange-programs.service
 */

import { query } from '../../config/database.js'
import { SellError } from './sell-requests.service.js'

const num = (v) => (v == null ? null : Number(v))
const ICONS = ['phone', 'tablet', 'laptop', 'headphones', 'earbuds', 'watch', 'speaker', 'camera', 'console', 'other']

const serializeType = (t) => ({
  key: t.key, label: t.label, icon: t.icon, needsImei: t.needs_imei, hasScreen: t.has_screen,
  hasBattery: t.has_battery, hasCamera: t.has_camera, sortOrder: t.sort_order, isActive: t.is_active,
})

export async function listTypes({ includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM exchange_device_types ${includeInactive ? '' : 'WHERE is_active = TRUE'} ORDER BY sort_order, label`
  )
  return rows.map(serializeType)
}

export async function saveType(input, key = null) {
  const bool = (v, d) => (typeof v === 'boolean' ? v : d)
  const label = String(input.label ?? '').trim()
  const k = key ?? String(input.key ?? label).trim().replace(/\s+/g, ' ')
  if (!k || k.length > 40) throw new SellError('VALIDATION', 'Device type name is required (up to 40 characters)', 422)
  if (!label) throw new SellError('VALIDATION', 'Label is required', 422)
  const icon = input.icon ?? 'other'
  if (!ICONS.includes(icon)) throw new SellError('VALIDATION', 'Unknown icon', 422)
  const { rows: cur } = await query('SELECT * FROM exchange_device_types WHERE key = $1', [k])
  const c = cur[0]
  if (key && !c) throw new SellError('NOT_FOUND', 'Device type not found', 404)
  if (!key && c) throw new SellError('EXISTS', 'This device type already exists', 409)
  const v = {
    needs_imei: bool(input.needsImei, c?.needs_imei ?? false),
    has_screen: bool(input.hasScreen, c?.has_screen ?? true),
    has_battery: bool(input.hasBattery, c?.has_battery ?? true),
    has_camera: bool(input.hasCamera, c?.has_camera ?? false),
    is_active: bool(input.isActive, c?.is_active ?? true),
    sort_order: Number.isInteger(input.sortOrder) ? input.sortOrder : c?.sort_order ?? 50,
  }
  const { rows } = await query(
    `INSERT INTO exchange_device_types (key, label, icon, needs_imei, has_screen, has_battery, has_camera, sort_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (key) DO UPDATE SET label=$2, icon=$3, needs_imei=$4, has_screen=$5, has_battery=$6, has_camera=$7, sort_order=$8, is_active=$9, updated_at=NOW()
     RETURNING *`,
    [k, label, icon, v.needs_imei, v.has_screen, v.has_battery, v.has_camera, v.sort_order, v.is_active]
  )
  return serializeType(rows[0])
}

export async function assertTypeExists(key) {
  const { rows } = await query('SELECT 1 FROM exchange_device_types WHERE key = $1', [key])
  if (!rows[0]) throw new SellError('VALIDATION', 'Choose a device type from the list (add new types under Exchange programs)', 422)
}

// ── programs ────────────────────────────────────────────────────────────

const serializeProgram = (p, cats = [], prods = []) => ({
  id: p.id, name: p.name, deviceTypes: p.device_types, categoryIds: p.category_ids, productIds: p.product_ids,
  maxValuePct: num(p.max_value_pct), isActive: p.is_active, sortOrder: p.sort_order,
  categories: cats.filter((c) => p.category_ids.includes(c.id)),
  products: prods.filter((x) => p.product_ids.includes(x.id)),
})

export async function listPrograms() {
  const { rows } = await query('SELECT * FROM exchange_programs ORDER BY sort_order, created_at')
  const catIds = [...new Set(rows.flatMap((r) => r.category_ids))]
  const prodIds = [...new Set(rows.flatMap((r) => r.product_ids))]
  const cats = catIds.length ? (await query('SELECT id, name FROM categories WHERE id = ANY($1::uuid[])', [catIds])).rows : []
  const prods = prodIds.length ? (await query('SELECT id, name FROM products WHERE id = ANY($1::uuid[])', [prodIds])).rows : []
  return rows.map((r) => serializeProgram(r, cats, prods))
}

async function parseProgram(input, base = {}) {
  const name = String(input.name ?? base.name ?? '').trim()
  if (!name) throw new SellError('VALIDATION', 'Programme name is required', 422)
  const arr = (v, d) => (Array.isArray(v) ? v : d)
  const deviceTypes = arr(input.deviceTypes, base.device_types ?? [])
  if (!deviceTypes.length) throw new SellError('VALIDATION', 'Pick at least one old-device type to accept', 422)
  const { rows: t } = await query('SELECT key FROM exchange_device_types WHERE key = ANY($1::text[])', [deviceTypes])
  if (t.length !== new Set(deviceTypes).size) throw new SellError('VALIDATION', 'Unknown device type', 422)
  const categoryIds = arr(input.categoryIds, base.category_ids ?? [])
  const productIds = arr(input.productIds, base.product_ids ?? [])
  if (!categoryIds.length && !productIds.length) throw new SellError('VALIDATION', 'Pick at least one category or product this programme applies to', 422)
  const pct = Number(input.maxValuePct ?? base.max_value_pct ?? 100)
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new SellError('VALIDATION', 'Maximum trade-in share must be 1–100% of the new price', 422)
  return {
    name, deviceTypes, categoryIds, productIds, pct,
    isActive: typeof input.isActive === 'boolean' ? input.isActive : base.is_active ?? true,
    sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder : base.sort_order ?? 0,
  }
}

export async function createProgram(input) {
  const p = await parseProgram(input)
  const { rows } = await query(
    `INSERT INTO exchange_programs (name, device_types, category_ids, product_ids, max_value_pct, is_active, sort_order)
     VALUES ($1,$2,$3::uuid[],$4::uuid[],$5,$6,$7) RETURNING *`,
    [p.name, p.deviceTypes, p.categoryIds, p.productIds, p.pct, p.isActive, p.sortOrder]
  )
  return (await listPrograms()).find((x) => x.id === rows[0].id)
}

export async function updateProgram(id, input) {
  const { rows: cur } = await query('SELECT * FROM exchange_programs WHERE id = $1', [id])
  if (!cur[0]) throw new SellError('NOT_FOUND', 'Programme not found', 404)
  const p = await parseProgram(input, cur[0])
  await query(
    `UPDATE exchange_programs SET name=$2, device_types=$3, category_ids=$4::uuid[], product_ids=$5::uuid[], max_value_pct=$6, is_active=$7, sort_order=$8, updated_at=NOW() WHERE id=$1`,
    [id, p.name, p.deviceTypes, p.categoryIds, p.productIds, p.pct, p.isActive, p.sortOrder]
  )
  return (await listPrograms()).find((x) => x.id === id)
}

export async function deleteProgram(id) {
  const { rowCount } = await query('DELETE FROM exchange_programs WHERE id = $1', [id])
  if (!rowCount) throw new SellError('NOT_FOUND', 'Programme not found', 404)
  return { deleted: true }
}

// ── per product ─────────────────────────────────────────────────────────

/** Active programmes that cover this product (its category, any parent category, or the product itself). */
async function programsFor(productId) {
  const { rows } = await query(
    `WITH RECURSIVE chain AS (
        SELECT c.id, c.parent_id FROM categories c JOIN products p ON p.category_id = c.id WHERE p.id = $1
        UNION ALL
        SELECT c.id, c.parent_id FROM categories c JOIN chain ON chain.parent_id = c.id)
     SELECT pr.* FROM exchange_programs pr
      WHERE pr.is_active = TRUE
        AND ($1::uuid = ANY(pr.product_ids) OR EXISTS (SELECT 1 FROM chain WHERE chain.id = ANY(pr.category_ids)))
      ORDER BY pr.sort_order, pr.created_at`,
    [productId]
  )
  return rows
}

async function productPrice(productId) {
  const { rows } = await query('SELECT name, COALESCE(sale_price, price) AS price FROM products WHERE id = $1 AND is_active = TRUE', [productId])
  return rows[0] ? { name: rows[0].name, price: num(rows[0].price) } : null
}

/**
 * Guest-safe answer for the product page: is exchange offered on this product, which old devices are
 * accepted and what they normally fetch (taken from the live catalogue, capped at the programme's share of the price).
 */
export async function forProduct(productId) {
  const none = { eligible: false, types: [], maxValue: 0 }
  const product = await productPrice(productId)
  if (!product) return none
  const { rows: s } = await query('SELECT enabled FROM sell_settings WHERE id = TRUE')
  if (!s[0]?.enabled) return none
  const programs = await programsFor(productId)
  if (!programs.length) return none
  const cap = Math.max(...programs.map((p) => (product.price * num(p.max_value_pct)) / 100))
  const keys = [...new Set(programs.flatMap((p) => p.device_types))]
  const { rows: types } = await query('SELECT * FROM exchange_device_types WHERE key = ANY($1::text[]) AND is_active = TRUE ORDER BY sort_order, label', [keys])
  const { rows: stats } = await query(
    `SELECT category, COUNT(*)::int AS models, MAX(base_price) AS top,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY base_price) AS mid, MIN(base_price) AS low
       FROM sell_device_models WHERE is_active = TRUE AND category = ANY($1::text[]) GROUP BY category`, [keys])
  const by = Object.fromEntries(stats.map((r) => [r.category, r]))
  const out = types.filter((t) => by[t.key]).map((t) => {
    const r = by[t.key]
    const pct = Math.max(...programs.filter((p) => p.device_types.includes(t.key)).map((p) => num(p.max_value_pct)))
    const limit = (product.price * pct) / 100
    return { ...serializeType(t), models: r.models, upTo: Math.round(Math.min(num(r.top), limit)), typical: Math.round(Math.min(num(r.mid), limit)), from: Math.round(Math.min(num(r.low), limit)) }
  })
  if (!out.length) return none
  return { eligible: true, types: out, maxValue: Math.round(Math.min(cap, Math.max(...out.map((t) => t.upTo)))), price: product.price }
}

/** What the exchange flow needs: accepted types with their questions, plus the models for them. */
export async function optionsForProduct(productId) {
  const info = await forProduct(productId)
  if (!info.eligible) throw new SellError('NOT_ELIGIBLE', 'Exchange is not available for this product', 404)
  const { rows } = await query(
    `SELECT * FROM sell_device_models WHERE is_active = TRUE AND base_price IS NOT NULL AND category = ANY($1::text[]) ORDER BY category, name`, [info.types.map((t) => t.key)])
  return { ...info, models: rows }
}

/**
 * Used when an exchange is created: the old device must be of an accepted type, and the credit is capped.
 * Returns the maximum credit (rupees) allowed for this product + device type.
 */
export async function creditLimit(productId, deviceType) {
  const product = await productPrice(productId)
  if (!product) throw new SellError('NOT_FOUND', 'Product not found', 404)
  const programs = (await programsFor(productId)).filter((p) => p.device_types.includes(deviceType))
  if (!programs.length) throw new SellError('NOT_ELIGIBLE', 'This product cannot be bought with that kind of old device', 422)
  return Math.floor((product.price * Math.max(...programs.map((p) => num(p.max_value_pct)))) / 100)
}
