import { query, getClient } from '../../config/database.js'
import { QcService } from '../qc/qc.service.js'
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js'

const qc = new QcService()
const subscriptions = new SubscriptionsService()

const CONDITIONS = ['NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']
const USED = ['USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']
const err = (statusCode, message, code = 'LISTING_ERROR') => Object.assign(new Error(message), { statusCode, code })
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80)

const BASE = `
  FROM shop_products sp
  JOIN products p ON p.id = sp.product_id
  JOIN shops s ON s.id = sp.shop_id
  LEFT JOIN vendors v ON v.id = p.owner_vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
 WHERE sp.deleted_at IS NULL AND p.deleted_at IS NULL`

const CARD = `
  SELECT sp.id, sp.product_id, p.name, p.brand, p.condition, p.owner_type, p.owner_vendor_id AS vendor_id,
         COALESCE(v.name, 'Dealker') AS owner_name, c.name AS category_name, p.category_id,
         p.thumbnail_url, COALESCE(jsonb_array_length(p.images), 0) AS image_count,
         COALESCE(sp.sale_price, sp.price) AS price, sp.mrp, sp.stock_quantity AS stock,
         sp.approval_status, sp.listing_status, sp.rejection_reason, sp.sold_count, sp.created_at, p.sku,
         sp.qc_status, sp.qc_score, sp.merch_section, sp.sell_b2c, sp.sell_b2b`

function toCard(r) {
  return {
    ...r,
    price: Number(r.price), mrp: r.mrp != null ? Number(r.mrp) : null, image_count: Number(r.image_count),
    stock: Number(r.stock), sold_count: Number(r.sold_count || 0),
  }
}

export const listingsService = {
  CONDITIONS,

  async list(scope, q = {}) {
    const { owner, vendorId, condition, categoryId, approval, qc: qcFilter, section, channel, stock, status, search, sort = 'newest', page = 1, limit = 25 } = q
    const where = []; const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (scope.vendorId) where.push(`p.owner_vendor_id = ${p(scope.vendorId)}`)
    else {
      if (owner) where.push(`p.owner_type = ${p(owner)}`)
      if (vendorId) where.push(`p.owner_vendor_id = ${p(vendorId)}`)
    }
    if (condition) where.push(condition === 'USED' ? `p.condition = ANY(${p(USED)})` : `p.condition = ${p(condition)}`)
    if (categoryId) where.push(`p.category_id = ${p(categoryId)}`)
    if (approval) where.push(`sp.approval_status = ${p(approval)}`)
    if (qcFilter) where.push(`sp.qc_status = ${p(qcFilter)}`)
    if (section) where.push(section === 'NONE' ? 'sp.merch_section IS NULL' : `sp.merch_section = ${p(section)}`)
    if (channel === 'B2C') where.push('sp.sell_b2c = TRUE')
    if (channel === 'B2B') where.push('sp.sell_b2b = TRUE')
    if (status) where.push(`sp.listing_status = ${p(status)}`)
    if (stock === 'out') where.push('sp.stock_quantity = 0')
    if (stock === 'in') where.push('sp.stock_quantity > 0')
    if (stock === 'low') where.push('sp.stock_quantity > 0 AND sp.stock_quantity <= sp.low_stock_threshold')
    if (search) { const s = p(`%${search}%`); where.push(`(p.name ILIKE ${s} OR p.brand ILIKE ${s} OR p.sku ILIKE ${s} OR v.name ILIKE ${s})`) }
    const w = where.length ? ` AND ${where.join(' AND ')}` : ''
    const order = { newest: 'sp.created_at DESC', price_asc: 'COALESCE(sp.sale_price, sp.price) ASC', price_desc: 'COALESCE(sp.sale_price, sp.price) DESC',
      stock: 'sp.stock_quantity ASC', name: 'p.name ASC' }[sort] || 'sp.created_at DESC'
    const lim = Math.min(100, Number(limit) || 25)
    const off = (Math.max(1, Number(page)) - 1) * lim
    const cnt = await query(`SELECT COUNT(*)::int n ${BASE}${w}`, params)
    const { rows } = await query(`${CARD} ${BASE}${w} ORDER BY (sp.approval_status = 'PENDING') DESC, ${order} LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows.map(toCard), pagination: { page: Number(page), limit: lim, total: cnt.rows[0].n } }
  },

  async stats(scope) {
    const vid = scope.vendorId
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE p.owner_type = 'ADMIN')::int AS admin,
              COUNT(*) FILTER (WHERE p.owner_type = 'VENDOR')::int AS vendor,
              COUNT(*) FILTER (WHERE sp.approval_status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE sp.approval_status = 'REJECTED')::int AS rejected,
              COUNT(*) FILTER (WHERE p.condition = ANY($1))::int AS used,
              COUNT(*) FILTER (WHERE sp.stock_quantity = 0)::int AS out_of_stock
         ${BASE}${vid ? ' AND p.owner_vendor_id = $2' : ''}`, vid ? [USED, vid] : [USED])
    return rows[0]
  },

  async vendorsFilter() {
    const { rows } = await query(
      `SELECT v.id, v.name, COUNT(*)::int AS listings FROM products p JOIN vendors v ON v.id = p.owner_vendor_id
        JOIN shop_products sp ON sp.product_id = p.id AND sp.deleted_at IS NULL
        WHERE p.deleted_at IS NULL GROUP BY v.id, v.name ORDER BY v.name`)
    return rows
  },

  async detail(id, scope) {
    const { rows } = await query(
      `SELECT sp.id, sp.shop_id, sp.product_id, sp.approval_status, sp.listing_status, sp.rejection_reason, sp.approved_at,
              sp.price AS selling_price, sp.mrp, sp.stock_quantity, sp.handling_time_days, sp.cod_eligible,
              sp.nationwide_shipping_enabled, sp.local_delivery_enabled, sp.weight_grams, sp.seller_sku, sp.sold_count, sp.created_at,
              p.name, p.brand, p.description, p.category_id, c.name AS category_name, p.images, p.thumbnail_url, p.condition, p.condition_notes,
              p.usage_duration, p.warranty_info, p.accessories_included, p.battery_health, p.serial_number, p.imei, p.has_invoice, p.hsn_code,
              sp.qc_status, sp.qc_mode, sp.qc_score, sp.qc_notes, sp.qc_checked_at,
              p.gst_rate, p.specifications, p.return_policy_days, p.owner_type, p.owner_vendor_id AS vendor_id, COALESCE(v.name,'Dealker') AS owner_name
         ${BASE} AND sp.id = $1 ${scope.vendorId ? 'AND p.owner_vendor_id = $2' : ''}`, scope.vendorId ? [id, scope.vendorId] : [id])
    if (!rows[0]) throw err(404, 'Listing not found', 'NOT_FOUND')
    const r = rows[0]
    return { ...r, selling_price: Number(r.selling_price), mrp: r.mrp != null ? Number(r.mrp) : null,
      images: r.images || [], specifications: r.specifications || {} }
  },

  validate(input, { partial = false } = {}) {
    const e = []
    const need = (k, label) => { if (!partial && (input[k] === undefined || input[k] === null || input[k] === '')) e.push(`${label} is required`) }
    need('name', 'Title'); need('categoryId', 'Category'); need('condition', 'Condition'); need('price', 'Price'); need('stock', 'Quantity')
    if (input.condition !== undefined && !CONDITIONS.includes(input.condition)) e.push('Invalid condition')
    if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length < 3)) e.push('At least 3 photos are required')
    if (!partial && !input.images) e.push('At least 3 photos are required')
    if (input.images && input.images.length > 8) e.push('A maximum of 8 photos is allowed')
    if (input.price !== undefined && !(Number(input.price) > 0)) e.push('Price must be greater than 0')
    if (input.mrp !== undefined && input.mrp !== null && Number(input.mrp) < Number(input.price)) e.push('MRP cannot be lower than the selling price')
    const cond = input.condition
    if (cond && USED.includes(cond) && !partial && !String(input.conditionNotes || '').trim()) e.push('Describe the condition (scratches, usage) for used items')
    if (cond && USED.includes(cond) && Number(input.stock) > 1) e.push('Used items are single-unit listings (quantity 1)')
    if (e.length) throw err(400, e.join('. '), 'VALIDATION_ERROR')
  },

  async create(input, scope) {
    this.validate(input)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      let shopId; let ownerType; let vendorId = null; let approval = 'PENDING'
      if (scope.vendorId) {
        await subscriptions.assertCanList(scope.vendorId) // plan listing limit
        ownerType = 'VENDOR'; vendorId = scope.vendorId
        const s = await client.query(`SELECT s.id FROM shops s JOIN vendors v ON v.id = s.vendor_id WHERE s.vendor_id = $1 AND s.is_active = true AND s.deleted_at IS NULL ORDER BY s.created_at LIMIT 1`, [vendorId])
        if (!s.rows[0]) throw err(409, 'Your store is not active yet — complete KYC first', 'NO_ACTIVE_SHOP')
        shopId = s.rows[0].id
      } else if (input.ownerVendorId) {
        // Admin listing on behalf of a vendor — goes live immediately, owned by that vendor
        ownerType = 'VENDOR'; vendorId = input.ownerVendorId; approval = 'APPROVED'
        const s = await client.query(`SELECT id FROM shops WHERE vendor_id = $1 AND deleted_at IS NULL ORDER BY is_active DESC, created_at LIMIT 1`, [vendorId])
        if (!s.rows[0]) throw err(409, 'That vendor has no store yet', 'NO_ACTIVE_SHOP')
        shopId = s.rows[0].id
      } else {
        ownerType = 'ADMIN'; approval = 'APPROVED'
        shopId = (await client.query(`SELECT id FROM shops WHERE is_platform = true LIMIT 1`)).rows[0].id
      }
      const pid = (await client.query(
        `INSERT INTO products (name, slug, description, price, sale_price, category_id, stock_quantity, unit, thumbnail_url, images, is_active, sku, brand,
           hsn_code, gst_rate, specifications, return_policy_days, owner_type, owner_vendor_id, condition, condition_notes, usage_duration, warranty_info,
           accessories_included, battery_health, serial_number, has_invoice, max_order_qty, imei)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pc',$8,$9,true,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id`,
        [input.name.trim(), `${slugify(input.name)}-${Math.random().toString(36).slice(2, 7)}`, input.description || null, input.mrp ?? input.price, input.price,
          input.categoryId, input.stock, input.images[0], JSON.stringify(input.images), input.sku || null, input.brand || null,
          input.hsnCode || null, input.gstRate ?? null, JSON.stringify(input.specifications || {}), input.returnPolicyDays ?? 7, ownerType, vendorId,
          input.condition, input.conditionNotes || null, input.usageDuration || null, input.warrantyInfo || null, input.accessoriesIncluded || null,
          input.batteryHealth ?? null, input.serialNumber || null, Boolean(input.hasInvoice), USED.includes(input.condition) ? 1 : 10,
          input.imei ? String(input.imei).replace(/[\s-]/g, '') : null])).rows[0].id
      const spId = (await client.query(
        `INSERT INTO shop_products (shop_id, product_id, price, sale_price, mrp, stock_quantity, low_stock_threshold, max_order_qty, is_available, approval_status,
           approved_at, approved_by, seller_sku, min_order_qty, handling_time_days, weight_grams, cod_eligible, nationwide_shipping_enabled, local_delivery_enabled, listing_status)
         VALUES ($1,$2,$3,$3,$4,$5,2,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [shopId, pid, input.price, input.mrp ?? input.price, input.stock, USED.includes(input.condition) ? 1 : 10, Number(input.stock) > 0, approval,
          approval === 'APPROVED' ? new Date() : null, approval === 'APPROVED' ? scope.actorId : null, input.sku || null, input.handlingTimeDays ?? 2,
          input.weightGrams ?? null, input.codEligible ?? true, input.nationwide ?? true, input.localDelivery ?? true,
          Number(input.stock) > 0 ? 'ACTIVE' : 'OUT_OF_STOCK'])).rows[0].id
      await client.query('COMMIT')
      await qc.autoIfEnabled(spId)
      return this.detail(spId, { vendorId: null })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
  },

  async update(id, input, scope) {
    this.validate(input, { partial: true })
    const cur = await this.detail(id, scope)
    const contentKeys = ['name', 'description', 'images', 'condition', 'conditionNotes', 'usageDuration', 'warrantyInfo', 'accessoriesIncluded', 'batteryHealth', 'categoryId', 'brand', 'serialNumber', 'imei']
    const contentChanged = contentKeys.some((k) => input[k] !== undefined)
    const cond = input.condition ?? cur.condition
    if (USED.includes(cond) && Number(input.stock ?? cur.stock_quantity) > 1) throw err(400, 'Used items are single-unit listings (quantity 1)', 'VALIDATION_ERROR')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const sets = []; const vals = [cur.product_id]
      const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
      const map = { name: 'name', description: 'description', categoryId: 'category_id', brand: 'brand', condition: 'condition', conditionNotes: 'condition_notes',
        usageDuration: 'usage_duration', warrantyInfo: 'warranty_info', accessoriesIncluded: 'accessories_included', batteryHealth: 'battery_health',
        serialNumber: 'serial_number', imei: 'imei', hasInvoice: 'has_invoice', hsnCode: 'hsn_code', gstRate: 'gst_rate', returnPolicyDays: 'return_policy_days' }
      for (const [k, col] of Object.entries(map)) {
        if (input[k] === undefined) continue
        set(col, k === 'imei' && input[k] ? String(input[k]).replace(/[\s-]/g, '') : input[k])
      }
      if (input.images !== undefined) { set('images', JSON.stringify(input.images)); set('thumbnail_url', input.images[0]) }
      if (input.specifications !== undefined) set('specifications', JSON.stringify(input.specifications))
      if (input.price !== undefined) { set('sale_price', input.price); if (input.mrp === undefined && cur.mrp == null) set('price', input.price) }
      if (input.mrp !== undefined) set('price', input.mrp)
      if (input.stock !== undefined) set('stock_quantity', input.stock)
      if (sets.length) await client.query(`UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals)

      const ss = []; const sv = [id]
      const sset = (col, v) => { sv.push(v); ss.push(`${col} = $${sv.length}`) }
      if (input.price !== undefined) { sset('price', input.price); sset('sale_price', input.price) }
      if (input.mrp !== undefined) sset('mrp', input.mrp)
      if (input.stock !== undefined) {
        sset('stock_quantity', input.stock); sset('is_available', Number(input.stock) > 0)
        if (cur.listing_status !== 'PAUSED') sset('listing_status', Number(input.stock) > 0 ? 'ACTIVE' : 'OUT_OF_STOCK')
      }
      if (input.handlingTimeDays !== undefined) sset('handling_time_days', input.handlingTimeDays)
      if (input.codEligible !== undefined) sset('cod_eligible', input.codEligible)
      if (input.nationwide !== undefined) sset('nationwide_shipping_enabled', input.nationwide)
      if (input.localDelivery !== undefined) sset('local_delivery_enabled', input.localDelivery)
      if (input.weightGrams !== undefined) sset('weight_grams', input.weightGrams)
      if (input.sku !== undefined) sset('seller_sku', input.sku)
      // vendors re-enter the review queue when listing content changes
      if (scope.vendorId && contentChanged) ss.push("approval_status = 'PENDING'", 'rejection_reason = NULL')
      if (ss.length) await client.query(`UPDATE shop_products SET ${ss.join(', ')}, updated_at = NOW() WHERE id = $1`, sv)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
    if (contentChanged) {
      // an earlier QC decision describes the old content
      await qc.reset(id).catch(() => {})
      await qc.autoIfEnabled(id)
    }
    return this.detail(id, scope)
  },

  async approve(id, actorId) {
    const qcSettings = await qc.getSettings()
    if (qcSettings.requirePassToPublish) {
      const { rows } = await query(`SELECT qc_status FROM shop_products WHERE id = $1 AND deleted_at IS NULL`, [id])
      if (rows[0] && rows[0].qc_status !== 'QC_PASSED') throw err(409, 'QC must pass before this listing can be approved', 'QC_NOT_PASSED')
    }
    const { rowCount } = await query(
      `UPDATE shop_products SET approval_status='APPROVED', approved_at=NOW(), approved_by=$2, rejection_reason=NULL, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [id, actorId])
    if (!rowCount) throw err(404, 'Listing not found', 'NOT_FOUND')
    return this.detail(id, {})
  },

  async reject(id, reason, actorId) {
    if (!String(reason || '').trim()) throw err(400, 'Please tell the seller what to fix', 'VALIDATION_ERROR')
    const { rowCount } = await query(
      `UPDATE shop_products SET approval_status='REJECTED', rejection_reason=$2, approved_by=$3, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [id, reason.trim(), actorId])
    if (!rowCount) throw err(404, 'Listing not found', 'NOT_FOUND')
    return this.detail(id, {})
  },

  async setStatus(id, listingStatus, scope) {
    await this.detail(id, scope)
    await query(`UPDATE shop_products SET listing_status=$2, is_available=($2='ACTIVE'), updated_at=NOW() WHERE id=$1`, [id, listingStatus])
    return this.detail(id, scope)
  },

  async remove(id, scope) {
    const cur = await this.detail(id, scope)
    await query(`UPDATE shop_products SET deleted_at = NOW(), is_available = false WHERE id = $1`, [id])
    await query(`UPDATE products SET deleted_at = NOW(), is_active = false WHERE id = $1`, [cur.product_id])
  },
}
