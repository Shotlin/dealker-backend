/**
 * Pricing service — global price control, bulk stock, batch history + revert.
 *
 * Preview never writes. Apply recomputes on locked rows inside one
 * transaction, stores every old → new value, and can be reverted later
 * (only listings whose value is still the one we set are restored).
 *
 * @module modules/pricing/pricing.service
 */

import { query, getClient } from '../../config/database.js'
import {
  computePrice, computeStock, summarise, validatePriceParams, validateStockParams,
} from './price.engine.js'

const MAX_ROWS = 5000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USED = ['USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']
const httpError = (statusCode, message, code = 'PRICING_ERROR') => Object.assign(new Error(message), { statusCode, code })

function cleanScope(scope = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  const s = {
    all: scope.all === true,
    vendorIds: arr(scope.vendorIds), categoryIds: arr(scope.categoryIds), brands: arr(scope.brands).map(String),
    listingIds: arr(scope.listingIds), excludeListingIds: arr(scope.excludeListingIds), owner: scope.owner || null, channel: scope.channel || null,
  }
  for (const k of ['vendorIds', 'categoryIds', 'listingIds', 'excludeListingIds']) {
    if (s[k].some((id) => !UUID.test(String(id)))) throw httpError(400, `${k} must contain valid ids`, 'VALIDATION')
  }
  if (s.listingIds.length > MAX_ROWS) throw httpError(400, `Select at most ${MAX_ROWS} listings at a time`, 'VALIDATION')
  if (s.owner && !['ADMIN', 'VENDOR'].includes(s.owner)) throw httpError(400, 'owner must be ADMIN or VENDOR', 'VALIDATION')
  if (s.channel && !['B2C', 'B2B'].includes(s.channel)) throw httpError(400, 'channel must be B2C or B2B', 'VALIDATION')
  const narrowed = s.vendorIds.length || s.categoryIds.length || s.brands.length || s.listingIds.length || s.owner || s.channel
  if (!s.all && !narrowed) throw httpError(400, 'Choose which products to change (a vendor, category, brand, specific products) or switch on “all products”', 'SCOPE_REQUIRED')
  return s
}

function scopeWhere(s) {
  const where = ['sp.deleted_at IS NULL', 'p.deleted_at IS NULL']
  const params = []
  const p = (v) => { params.push(v); return `$${params.length}` }
  if (s.vendorIds.length) where.push(`p.owner_vendor_id = ANY(${p(s.vendorIds)}::uuid[])`)
  if (s.categoryIds.length) where.push(`p.category_id = ANY(${p(s.categoryIds)}::uuid[])`)
  if (s.brands.length) where.push(`lower(p.brand) = ANY(${p(s.brands.map((b) => b.toLowerCase()))}::text[])`)
  if (s.listingIds.length) where.push(`sp.id = ANY(${p(s.listingIds)}::uuid[])`)
  if (s.excludeListingIds.length) where.push(`NOT (sp.id = ANY(${p(s.excludeListingIds)}::uuid[]))`)
  if (s.owner) where.push(`p.owner_type = ${p(s.owner)}`)
  if (s.channel === 'B2C') where.push('sp.sell_b2c = TRUE')
  if (s.channel === 'B2B') where.push('sp.sell_b2b = TRUE')
  return { clause: where.join(' AND '), params }
}

const ROWS_SQL = `
  SELECT sp.id, sp.price, sp.sale_price, sp.mrp, sp.wholesale_price, sp.stock_quantity,
         COALESCE(sp.cost_price, p.cost_price) AS cost, p.name, p.brand, p.condition, p.id AS product_id
    FROM shop_products sp JOIN products p ON p.id = sp.product_id`

export class PricingService {
  /** Listing ids a scope matches (used by campaigns for section placement). */
  async resolveScope(scope) {
    const s = cleanScope(scope)
    const w = scopeWhere(s)
    const { rows } = await query(`SELECT sp.id FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE ${w.clause} LIMIT ${MAX_ROWS + 1}`, w.params)
    if (rows.length > MAX_ROWS) throw httpError(400, `This touches more than ${MAX_ROWS} listings — narrow the scope`, 'TOO_MANY')
    return rows.map((r) => r.id)
  }

  async brands() {
    const { rows } = await query(
      `SELECT p.brand, COUNT(*)::int AS listings FROM shop_products sp JOIN products p ON p.id = sp.product_id
        WHERE sp.deleted_at IS NULL AND p.deleted_at IS NULL AND p.brand IS NOT NULL AND p.brand <> ''
        GROUP BY p.brand ORDER BY p.brand`)
    return rows
  }

  /** Turn scoped rows into per-field work items with a new value or skip reason. */
  #plan(rows, params) {
    const items = []
    const target = params.target || 'RETAIL'
    for (const r of rows) {
      if (target === 'RETAIL' || target === 'BOTH') {
        const old = Number(r.sale_price ?? r.price)
        if (!(old > 0)) items.push({ id: r.id, name: r.name, brand: r.brand, field: 'sale_price', old: null, skip: 'No selling price set' })
        else items.push({ id: r.id, name: r.name, brand: r.brand, field: 'sale_price', old, rawPrice: r.price != null ? Number(r.price) : null, ...computePrice({ old, mrp: r.mrp, cost: r.cost, field: 'sale_price' }, params) })
      }
      if (target === 'WHOLESALE' || target === 'BOTH') {
        if (r.wholesale_price == null) items.push({ id: r.id, name: r.name, brand: r.brand, field: 'wholesale_price', old: null, skip: 'No wholesale price set' })
        else items.push({ id: r.id, name: r.name, brand: r.brand, field: 'wholesale_price', old: Number(r.wholesale_price), ...computePrice({ old: Number(r.wholesale_price), mrp: r.mrp, cost: r.cost, field: 'wholesale_price' }, params) })
      }
    }
    return items
  }

  #validatePrice(params) {
    const err = validatePriceParams(params)
    if (err) throw httpError(400, err, 'VALIDATION')
    if (params.target && !['RETAIL', 'WHOLESALE', 'BOTH'].includes(params.target)) throw httpError(400, 'target must be RETAIL, WHOLESALE or BOTH', 'VALIDATION')
  }

  async previewPrice({ scope, params }) {
    this.#validatePrice(params)
    const s = cleanScope(scope)
    const w = scopeWhere(s)
    const { rows } = await query(`${ROWS_SQL} WHERE ${w.clause} ORDER BY p.name LIMIT ${MAX_ROWS + 1}`, w.params)
    if (rows.length > MAX_ROWS) throw httpError(400, `This touches more than ${MAX_ROWS} listings — narrow the scope`, 'TOO_MANY')
    const items = this.#plan(rows, params)
    return {
      summary: { ...summarise(items), listings: rows.length },
      sample: items.slice(0, 100).map((i) => ({ id: i.id, name: i.name, brand: i.brand, field: i.field, old: i.old, new: i.value ?? null, skip: i.skip ?? null })),
      truncated: items.length > 100,
    }
  }

  async applyPrice({ scope, params, note }, actorId) {
    this.#validatePrice(params)
    const s = cleanScope(scope)
    const w = scopeWhere(s)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`${ROWS_SQL} WHERE ${w.clause} ORDER BY p.name LIMIT ${MAX_ROWS + 1} FOR UPDATE OF sp`, w.params)
      if (rows.length > MAX_ROWS) throw httpError(400, `This touches more than ${MAX_ROWS} listings — narrow the scope`, 'TOO_MANY')
      const items = this.#plan(rows, params)
      const changes = items.filter((i) => i.value !== undefined)
      const skipped = items.length - changes.length
      if (!changes.length) throw httpError(409, 'Nothing would change with these settings', 'NOTHING_TO_DO')

      const batch = (await client.query(
        `INSERT INTO price_adjustment_batches (kind, operation, params, scope, note, item_count, skipped_count, created_by)
         VALUES ('PRICE',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [params.operation, JSON.stringify(params), JSON.stringify(s), note || null, changes.length, skipped, actorId || null]
      )).rows[0]

      await client.query(
        `INSERT INTO price_adjustment_items (batch_id, shop_product_id, field, old_value, new_value)
         SELECT $1, t.id, t.field, t.old, t.new
           FROM unnest($2::uuid[], $3::text[], $4::numeric[], $5::numeric[]) AS t(id, field, old, new)`,
        [batch.id, changes.map((c) => c.id), changes.map((c) => c.field), changes.map((c) => c.old), changes.map((c) => c.value)]
      )

      const retail = changes.filter((c) => c.field === 'sale_price')
      if (retail.length) {
        await client.query(
          `UPDATE shop_products sp
              SET sale_price = t.new,
                  price = CASE WHEN sp.price IS NULL OR sp.price = t.old THEN t.new ELSE sp.price END,
                  updated_at = NOW()
             FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS t(id, old, new)
            WHERE sp.id = t.id`,
          [retail.map((c) => c.id), retail.map((c) => c.old), retail.map((c) => c.value)]
        )
        await client.query(
          `UPDATE products p SET sale_price = t.new, updated_at = NOW()
             FROM shop_products sp, unnest($1::uuid[], $2::numeric[]) AS t(id, new)
            WHERE sp.id = t.id AND p.id = sp.product_id`,
          [retail.map((c) => c.id), retail.map((c) => c.value)]
        )
      }
      const wholesale = changes.filter((c) => c.field === 'wholesale_price')
      if (wholesale.length) {
        await client.query(
          `UPDATE shop_products sp SET wholesale_price = t.new, updated_at = NOW()
             FROM unnest($1::uuid[], $2::numeric[]) AS t(id, new) WHERE sp.id = t.id`,
          [wholesale.map((c) => c.id), wholesale.map((c) => c.value)]
        )
      }
      await client.query('COMMIT')
      return { batchId: batch.id, changed: changes.length, skipped }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  // ── Stock ───────────────────────────────────────────────────────────
  #planStock(rows, params) {
    return rows.map((r) => ({
      id: r.id, name: r.name, brand: r.brand, field: 'stock_quantity', old: Number(r.stock_quantity),
      ...computeStock({ old: Number(r.stock_quantity), used: USED.includes(r.condition) }, params),
    }))
  }

  async previewStock({ scope, params }) {
    const err = validateStockParams(params)
    if (err) throw httpError(400, err, 'VALIDATION')
    const s = cleanScope(scope)
    const w = scopeWhere(s)
    const { rows } = await query(`${ROWS_SQL} WHERE ${w.clause} ORDER BY p.name LIMIT ${MAX_ROWS + 1}`, w.params)
    if (rows.length > MAX_ROWS) throw httpError(400, `This touches more than ${MAX_ROWS} listings — narrow the scope`, 'TOO_MANY')
    const items = this.#planStock(rows, params)
    return {
      summary: { ...summarise(items), listings: rows.length },
      sample: items.slice(0, 100).map((i) => ({ id: i.id, name: i.name, brand: i.brand, field: i.field, old: i.old, new: i.value ?? null, skip: i.skip ?? null })),
      truncated: items.length > 100,
    }
  }

  async #writeStock(client, ids, values) {
    await client.query(
      `UPDATE shop_products sp
          SET stock_quantity = t.v,
              listing_status = CASE WHEN sp.listing_status = 'PAUSED' THEN 'PAUSED' WHEN t.v > 0 THEN 'ACTIVE' ELSE 'OUT_OF_STOCK' END,
              is_available = (t.v > 0 AND sp.listing_status <> 'PAUSED'),
              updated_at = NOW()
         FROM unnest($1::uuid[], $2::int[]) AS t(id, v) WHERE sp.id = t.id`, [ids, values])
    await client.query(
      `UPDATE products p SET stock_quantity = t.v, updated_at = NOW()
         FROM shop_products sp, unnest($1::uuid[], $2::int[]) AS t(id, v)
        WHERE sp.id = t.id AND p.id = sp.product_id`, [ids, values])
  }

  async applyStock({ scope, params, note }, actorId) {
    const err = validateStockParams(params)
    if (err) throw httpError(400, err, 'VALIDATION')
    const s = cleanScope(scope)
    const w = scopeWhere(s)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`${ROWS_SQL} WHERE ${w.clause} ORDER BY p.name LIMIT ${MAX_ROWS + 1} FOR UPDATE OF sp`, w.params)
      if (rows.length > MAX_ROWS) throw httpError(400, `This touches more than ${MAX_ROWS} listings — narrow the scope`, 'TOO_MANY')
      const items = this.#planStock(rows, params)
      const changes = items.filter((i) => i.value !== undefined)
      const skipped = items.length - changes.length
      if (!changes.length) throw httpError(409, 'Nothing would change with these settings', 'NOTHING_TO_DO')
      const batch = (await client.query(
        `INSERT INTO price_adjustment_batches (kind, operation, params, scope, note, item_count, skipped_count, created_by)
         VALUES ('STOCK',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [params.operation, JSON.stringify(params), JSON.stringify(s), note || null, changes.length, skipped, actorId || null])).rows[0]
      await client.query(
        `INSERT INTO price_adjustment_items (batch_id, shop_product_id, field, old_value, new_value)
         SELECT $1, t.id, 'stock_quantity', t.old, t.new
           FROM unnest($2::uuid[], $3::numeric[], $4::numeric[]) AS t(id, old, new)`,
        [batch.id, changes.map((c) => c.id), changes.map((c) => c.old), changes.map((c) => c.value)])
      await this.#writeStock(client, changes.map((c) => c.id), changes.map((c) => c.value))
      await client.query('COMMIT')
      return { batchId: batch.id, changed: changes.length, skipped }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  // ── History ─────────────────────────────────────────────────────────
  async batches({ page = 1, limit = 20 } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const total = (await query(`SELECT COUNT(*)::int n FROM price_adjustment_batches`)).rows[0].n
    const { rows } = await query(
      `SELECT b.*, u.name AS created_by_name, ru.name AS reverted_by_name
         FROM price_adjustment_batches b
         LEFT JOIN users u ON u.id = b.created_by LEFT JOIN users ru ON ru.id = b.reverted_by
        ORDER BY b.created_at DESC LIMIT ${lim} OFFSET ${off}`)
    return { data: rows, meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) } }
  }

  async batchItems(id, { page = 1, limit = 50 } = {}) {
    const b = (await query(`SELECT * FROM price_adjustment_batches WHERE id = $1`, [id])).rows[0]
    if (!b) throw httpError(404, 'Batch not found', 'NOT_FOUND')
    const lim = Math.min(200, Math.max(1, Number(limit) || 50))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const { rows } = await query(
      `SELECT i.field, i.old_value, i.new_value, p.name, p.brand, sp.id AS listing_id,
              CASE i.field WHEN 'sale_price' THEN COALESCE(sp.sale_price, sp.price)
                           WHEN 'wholesale_price' THEN sp.wholesale_price ELSE sp.stock_quantity END AS current_value
         FROM price_adjustment_items i
         JOIN shop_products sp ON sp.id = i.shop_product_id JOIN products p ON p.id = sp.product_id
        WHERE i.batch_id = $1 ORDER BY p.name LIMIT ${lim} OFFSET ${off}`, [id])
    return { batch: b, data: rows.map((r) => ({ ...r, old_value: Number(r.old_value), new_value: Number(r.new_value), current_value: r.current_value != null ? Number(r.current_value) : null })) }
  }

  async revert(id, actorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const b = (await client.query(`SELECT * FROM price_adjustment_batches WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (!b) throw httpError(404, 'Batch not found', 'NOT_FOUND')
      if (b.status === 'REVERTED') throw httpError(409, 'This batch was already reverted', 'ALREADY_REVERTED')
      const items = (await client.query(
        `SELECT i.shop_product_id AS id, i.field, i.old_value, i.new_value,
                CASE i.field WHEN 'sale_price' THEN COALESCE(sp.sale_price, sp.price)
                             WHEN 'wholesale_price' THEN sp.wholesale_price ELSE sp.stock_quantity END AS current_value
           FROM price_adjustment_items i JOIN shop_products sp ON sp.id = i.shop_product_id
          WHERE i.batch_id = $1 FOR UPDATE OF sp`, [id])).rows
      // Only undo listings still at the value this batch set; later edits are kept.
      const ok = items.filter((i) => Number(i.current_value) === Number(i.new_value))
      const conflicts = items.length - ok.length
      const by = (field) => ok.filter((i) => i.field === field)
      const retail = by('sale_price')
      if (retail.length) {
        await client.query(
          `UPDATE shop_products sp
              SET sale_price = t.old,
                  price = CASE WHEN sp.price = t.new THEN t.old ELSE sp.price END, updated_at = NOW()
             FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS t(id, old, new) WHERE sp.id = t.id`,
          [retail.map((i) => i.id), retail.map((i) => i.old_value), retail.map((i) => i.new_value)])
        await client.query(
          `UPDATE products p SET sale_price = t.old, updated_at = NOW()
             FROM shop_products sp, unnest($1::uuid[], $2::numeric[]) AS t(id, old) WHERE sp.id = t.id AND p.id = sp.product_id`,
          [retail.map((i) => i.id), retail.map((i) => i.old_value)])
      }
      const wh = by('wholesale_price')
      if (wh.length) {
        await client.query(
          `UPDATE shop_products sp SET wholesale_price = t.old, updated_at = NOW()
             FROM unnest($1::uuid[], $2::numeric[]) AS t(id, old) WHERE sp.id = t.id`,
          [wh.map((i) => i.id), wh.map((i) => i.old_value)])
      }
      const st = by('stock_quantity')
      if (st.length) await this.#writeStock(client, st.map((i) => i.id), st.map((i) => Number(i.old_value)))
      await client.query(
        `UPDATE price_adjustment_batches SET status = 'REVERTED', reverted_by = $2, reverted_at = NOW() WHERE id = $1`, [id, actorId || null])
      await client.query('COMMIT')
      return { restored: ok.length, conflicts }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }
}
