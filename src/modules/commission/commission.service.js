/**
 * Commission service — rule CRUD, resolution against the DB, order preview.
 *
 * @module modules/commission/commission.service
 */

import { query } from '../../config/database.js'
import { calculateSellerOrder } from './commission.engine.js'

const SCOPES = ['GLOBAL', 'VENDOR', 'CATEGORY', 'PRODUCT']
const CHANNELS = ['ALL', 'B2C', 'B2B']

function httpError(status, message, code) {
  const err = new Error(message)
  err.statusCode = status
  err.code = code
  return err
}

function pct(value, field) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, `${field} must be between 0 and 100`, 'VALIDATION')
  return n
}

function money(value, field) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `${field} must be 0 or more`, 'VALIDATION')
  return n
}

export class CommissionService {
  async loadActiveRules(client = null) {
    const run = client ? client.query.bind(client) : query
    const { rows } = await run(`SELECT * FROM commission_rules WHERE is_active = TRUE`)
    return rows
  }

  async list({ scope = '', channel = '', search = '', page = 1, limit = 20 } = {}) {
    const where = []
    const params = []
    if (scope) { params.push(scope); where.push(`r.scope = $${params.length}`) }
    if (channel) { params.push(channel); where.push(`r.channel = $${params.length}`) }
    if (search) {
      params.push(`%${search}%`)
      where.push(`(v.name ILIKE $${params.length} OR c.name ILIKE $${params.length} OR p.name ILIKE $${params.length})`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const offset = (Math.max(1, page) - 1) * limit
    const { rows } = await query(
      `SELECT r.*, v.name AS vendor_name, c.name AS category_name, p.name AS product_name,
              COUNT(*) OVER() AS total_count
         FROM commission_rules r
         LEFT JOIN vendors v ON v.id = r.vendor_id
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN products p ON p.id = r.product_id
         ${clause}
        ORDER BY r.is_active DESC,
                 CASE r.scope WHEN 'GLOBAL' THEN 1 WHEN 'VENDOR' THEN 2 WHEN 'CATEGORY' THEN 3 ELSE 4 END,
                 r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    )
    const total = Number(rows[0]?.total_count || 0)
    return {
      success: true,
      data: rows.map(({ total_count, ...r }) => r),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  #validate(input) {
    const scope = String(input.scope || '').toUpperCase()
    const channel = String(input.channel || 'ALL').toUpperCase()
    if (!SCOPES.includes(scope)) throw httpError(400, `scope must be one of ${SCOPES.join(', ')}`, 'VALIDATION')
    if (!CHANNELS.includes(channel)) throw httpError(400, `channel must be one of ${CHANNELS.join(', ')}`, 'VALIDATION')
    const target = {
      vendor_id: scope === 'VENDOR' ? input.vendorId : null,
      category_id: scope === 'CATEGORY' ? input.categoryId : null,
      product_id: scope === 'PRODUCT' ? input.productId : null,
    }
    if (scope === 'VENDOR' && !target.vendor_id) throw httpError(400, 'vendorId is required for a VENDOR rule', 'VALIDATION')
    if (scope === 'CATEGORY' && !target.category_id) throw httpError(400, 'categoryId is required for a CATEGORY rule', 'VALIDATION')
    if (scope === 'PRODUCT' && !target.product_id) throw httpError(400, 'productId is required for a PRODUCT rule', 'VALIDATION')
    return {
      scope, channel, ...target,
      commission_pct: pct(input.commissionPct, 'commissionPct'),
      platform_charge_flat: money(input.platformChargeFlat, 'platformChargeFlat'),
      platform_charge_pct: pct(input.platformChargePct, 'platformChargePct'),
      tax_pct: pct(input.taxPct, 'taxPct'),
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
    }
  }

  async create(input, actorId) {
    const v = this.#validate(input)
    try {
      const { rows } = await query(
        `INSERT INTO commission_rules
           (scope, vendor_id, category_id, product_id, channel, commission_pct,
            platform_charge_flat, platform_charge_pct, tax_pct, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [v.scope, v.vendor_id, v.category_id, v.product_id, v.channel, v.commission_pct,
         v.platform_charge_flat, v.platform_charge_pct, v.tax_pct, v.notes, actorId || null]
      )
      return rows[0]
    } catch (err) {
      if (err.code === '23505') throw httpError(409, 'An active rule already exists for this target and channel — edit it instead', 'DUPLICATE_RULE')
      if (err.code === '23503') throw httpError(400, 'The selected vendor, category or product does not exist', 'VALIDATION')
      throw err
    }
  }

  async update(id, input) {
    const { rows: existing } = await query(`SELECT * FROM commission_rules WHERE id = $1`, [id])
    if (!existing[0]) throw httpError(404, 'Rule not found', 'NOT_FOUND')
    const merged = {
      scope: existing[0].scope,
      vendorId: existing[0].vendor_id,
      categoryId: existing[0].category_id,
      productId: existing[0].product_id,
      channel: input.channel ?? existing[0].channel,
      commissionPct: input.commissionPct ?? existing[0].commission_pct,
      platformChargeFlat: input.platformChargeFlat ?? existing[0].platform_charge_flat,
      platformChargePct: input.platformChargePct ?? existing[0].platform_charge_pct,
      taxPct: input.taxPct ?? existing[0].tax_pct,
      notes: input.notes ?? existing[0].notes,
    }
    const v = this.#validate(merged)
    try {
      const { rows } = await query(
        `UPDATE commission_rules
            SET channel=$2, commission_pct=$3, platform_charge_flat=$4,
                platform_charge_pct=$5, tax_pct=$6, notes=$7,
                is_active = COALESCE($8, is_active), updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [id, v.channel, v.commission_pct, v.platform_charge_flat, v.platform_charge_pct,
         v.tax_pct, v.notes, typeof input.isActive === 'boolean' ? input.isActive : null]
      )
      return rows[0]
    } catch (err) {
      if (err.code === '23505') throw httpError(409, 'Another active rule already covers this target and channel', 'DUPLICATE_RULE')
      throw err
    }
  }

  async remove(id) {
    const { rowCount } = await query(`DELETE FROM commission_rules WHERE id = $1`, [id])
    if (!rowCount) throw httpError(404, 'Rule not found', 'NOT_FOUND')
  }

  /**
   * "What would this sale pay?" — Selling Price → Commission → Platform
   * Charge → Tax → Vendor Net, using the live rules.
   */
  async preview({ vendorId, channel = 'B2C', items, shippingCharge = 0 }) {
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'items[] is required', 'VALIDATION')
    const productIds = items.map((i) => i.productId).filter(Boolean)
    const catByProduct = new Map()
    if (productIds.length) {
      const { rows } = await query(`SELECT id, category_id FROM products WHERE id = ANY($1::uuid[])`, [productIds])
      rows.forEach((r) => catByProduct.set(r.id, r.category_id))
    }
    const rules = await this.loadActiveRules()
    return calculateSellerOrder({
      rules,
      vendorId,
      channel: channel === 'B2B' ? 'B2B' : 'B2C',
      shippingCharge,
      items: items.map((i) => ({
        productId: i.productId,
        categoryId: i.categoryId || catByProduct.get(i.productId) || null,
        lineTotal: Number(i.lineTotal ?? Number(i.price) * Number(i.quantity || 1)),
        discountShare: Number(i.discountShare || 0),
      })),
    })
  }

  /**
   * Used by checkout. Falls back to the shop's legacy `commission_rate`
   * when no rule matches so existing vendors keep their current economics.
   */
  async forCheckoutGroup(client, { vendorId, shopCommissionRate, items, discount, shippingCharge }) {
    const rules = await this.loadActiveRules(client)
    const ids = items.map((i) => i.productId).filter(Boolean)
    const catByProduct = new Map()
    if (ids.length) {
      const { rows } = await client.query(`SELECT id, category_id FROM products WHERE id = ANY($1::uuid[])`, [ids])
      rows.forEach((r) => catByProduct.set(r.id, r.category_id))
    }
    const subtotal = items.reduce((s, i) => s + Number(i.total), 0)
    const effectiveRules = rules.length ? rules : []
    // Legacy per-shop rate acts as a VENDOR-level fallback beneath any real rule.
    if (Number(shopCommissionRate) > 0) {
      effectiveRules.push({
        id: null, scope: vendorId ? 'VENDOR' : 'GLOBAL', vendor_id: vendorId || null, channel: 'ALL', is_active: true,
        commission_pct: shopCommissionRate, platform_charge_flat: 0, platform_charge_pct: 0, tax_pct: 0,
      })
    }
    return calculateSellerOrder({
      rules: effectiveRules,
      vendorId,
      channel: 'B2C',
      shippingCharge: 0,
      items: items.map((i) => ({
        productId: i.productId,
        categoryId: catByProduct.get(i.productId) || null,
        lineTotal: Number(i.total),
        discountShare: subtotal > 0 ? Number(((Number(i.total) / subtotal) * Number(discount || 0)).toFixed(2)) : 0,
      })),
    })
  }
}
