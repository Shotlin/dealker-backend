/**
 * Merchandising — product sections, B2C / B2B channels, bulk listing actions
 * and listing duplication.
 *
 * Sections: New Arrival, Deal of the Day, Clearance Sale, Featured, Best
 * Seller. A listing sits in at most one section (moving it replaces the
 * old one); Deal of the Day / Clearance can carry a start/end window.
 *
 * @module modules/merchandising/merchandising.service
 */

import crypto from 'node:crypto'
import { query, getClient } from '../../config/database.js'
import { listingsService } from '../listings/listings.service.js'

export const SECTIONS = {
  NEW_ARRIVAL: 'New Arrival',
  DEAL_OF_THE_DAY: 'Deal of the Day',
  CLEARANCE_SALE: 'Clearance Sale',
  FEATURED: 'Featured',
  BEST_SELLER: 'Best Seller',
}
const MAX_IDS = 200
const BULK_ACTIONS = ['APPROVE', 'PAUSE', 'RESUME', 'DELETE']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const httpError = (statusCode, message, code = 'MERCH_ERROR') => Object.assign(new Error(message), { statusCode, code })

function ids(list) {
  if (!Array.isArray(list) || !list.length) throw httpError(400, 'Select at least one product', 'VALIDATION')
  if (list.length > MAX_IDS) throw httpError(400, `Select at most ${MAX_IDS} products at a time`, 'VALIDATION')
  if (list.some((i) => !UUID.test(String(i)))) throw httpError(400, 'Invalid product id in the selection', 'VALIDATION')
  return [...new Set(list)]
}

export class MerchandisingService {
  definitions() {
    return Object.entries(SECTIONS).map(([key, label]) => ({ key, label }))
  }

  async overview() {
    const { rows } = await query(
      `SELECT merch_section AS section,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE merch_ends_at IS NOT NULL AND merch_ends_at < NOW())::int AS expired,
              COUNT(*) FILTER (WHERE merch_starts_at IS NOT NULL AND merch_starts_at > NOW())::int AS scheduled
         FROM shop_products WHERE deleted_at IS NULL AND merch_section IS NOT NULL GROUP BY merch_section`)
    const by = Object.fromEntries(rows.map((r) => [r.section, r]))
    const ch = (await query(
      `SELECT COUNT(*) FILTER (WHERE sell_b2c)::int AS b2c, COUNT(*) FILTER (WHERE sell_b2b)::int AS b2b,
              COUNT(*) FILTER (WHERE sell_b2c AND sell_b2b)::int AS both, COUNT(*)::int AS total
         FROM shop_products WHERE deleted_at IS NULL`)).rows[0]
    return {
      sections: this.definitions().map((d) => ({ ...d, total: by[d.key]?.total ?? 0, expired: by[d.key]?.expired ?? 0, scheduled: by[d.key]?.scheduled ?? 0 })),
      channels: ch,
    }
  }

  async listSection(section, { search = '', page = 1, limit = 25 } = {}) {
    if (section !== 'NONE' && !SECTIONS[section]) throw httpError(400, 'Unknown section', 'VALIDATION')
    const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    const where = ['sp.deleted_at IS NULL', 'p.deleted_at IS NULL', section === 'NONE' ? 'sp.merch_section IS NULL' : `sp.merch_section = ${p(section)}`]
    if (search) { const s = p(`%${search}%`); where.push(`(p.name ILIKE ${s} OR p.brand ILIKE ${s} OR v.name ILIKE ${s})`) }
    const lim = Math.min(100, Math.max(1, Number(limit) || 25))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const from = `FROM shop_products sp JOIN products p ON p.id = sp.product_id LEFT JOIN vendors v ON v.id = p.owner_vendor_id WHERE ${where.join(' AND ')}`
    const total = (await query(`SELECT COUNT(*)::int n ${from}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT sp.id, p.name, p.brand, p.condition, p.thumbnail_url, COALESCE(v.name, 'Dealker') AS owner_name,
              COALESCE(sp.sale_price, sp.price) AS price, sp.mrp, sp.stock_quantity AS stock, sp.approval_status, sp.listing_status,
              sp.merch_section, sp.merch_starts_at, sp.merch_ends_at, sp.merch_position, sp.sell_b2c, sp.sell_b2b, sp.qc_status
         ${from} ORDER BY sp.merch_position DESC, sp.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    return {
      data: rows.map((r) => ({ ...r, price: Number(r.price), mrp: r.mrp != null ? Number(r.mrp) : null })),
      meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) },
    }
  }

  /** Move listings into a section (or out of every section with section = null). */
  async move(idList, section, { startsAt = null, endsAt = null } = {}) {
    const list = ids(idList)
    if (section !== null && !SECTIONS[section]) throw httpError(400, `section must be null or one of ${Object.keys(SECTIONS).join(', ')}`, 'VALIDATION')
    const start = startsAt ? new Date(startsAt) : null
    const end = endsAt ? new Date(endsAt) : null
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) throw httpError(400, 'Invalid start or end date', 'VALIDATION')
    if (end && end.getTime() <= Date.now()) throw httpError(400, 'The end time must be in the future', 'VALIDATION')
    if (start && end && end <= start) throw httpError(400, 'The end time must be after the start time', 'VALIDATION')
    if (section === null && (start || end)) throw httpError(400, 'Dates only apply when moving into a section', 'VALIDATION')

    const client = await getClient()
    try {
      await client.query('BEGIN')
      let base = 0
      if (section) {
        base = (await client.query(`SELECT COALESCE(MAX(merch_position), 0) AS m FROM shop_products WHERE merch_section = $1 AND deleted_at IS NULL`, [section])).rows[0].m
      }
      const { rows } = await client.query(
        `UPDATE shop_products sp
            SET merch_section = $2, merch_starts_at = $3, merch_ends_at = $4,
                merch_position = CASE WHEN $2::text IS NULL THEN 0 ELSE $5::int + t.ord END,
                merch_updated_at = NOW(), is_featured = COALESCE($2::text = 'FEATURED', FALSE), updated_at = NOW()
           FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)
          WHERE sp.id = t.id AND sp.deleted_at IS NULL RETURNING sp.id, sp.product_id`,
        [list, section, start, end, Number(base)])
      if (rows.length) {
        await client.query(`UPDATE products SET is_featured = $2, updated_at = NOW() WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.product_id), section === 'FEATURED'])
      }
      await client.query('COMMIT')
      return { moved: rows.length, missing: list.length - rows.length }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async setChannels(idList, { b2c, b2b }) {
    const list = ids(idList)
    if (typeof b2c !== 'boolean' || typeof b2b !== 'boolean') throw httpError(400, 'b2c and b2b must both be true or false', 'VALIDATION')
    if (!b2c && !b2b) throw httpError(400, 'A product must be sold in at least one channel — pause it instead', 'VALIDATION')
    const { rowCount } = await query(
      `UPDATE shop_products SET sell_b2c = $2, sell_b2b = $3, updated_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [list, b2c, b2b])
    return { updated: rowCount }
  }

  /** Per-listing bulk action. One failure never blocks the rest. */
  async bulk(idList, action) {
    const list = ids(idList)
    if (!BULK_ACTIONS.includes(action)) throw httpError(400, `action must be one of ${BULK_ACTIONS.join(', ')}`, 'VALIDATION')
    const names = new Map((await query(`SELECT sp.id, p.name FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE sp.id = ANY($1::uuid[])`, [list])).rows.map((r) => [r.id, r.name]))
    let done = 0
    const failed = []
    for (const id of list) {
      try {
        if (action === 'APPROVE') await listingsService.approve(id, null)
        else if (action === 'PAUSE') await listingsService.setStatus(id, 'PAUSED', { vendorId: null })
        else if (action === 'RESUME') await listingsService.setStatus(id, 'ACTIVE', { vendorId: null })
        else await listingsService.remove(id, { vendorId: null })
        done += 1
      } catch (e) {
        failed.push({ id, name: names.get(id) || id, reason: e.message })
      }
    }
    return { done, failed }
  }

  /**
   * Copy a listing as a paused, pending draft. Identity fields (IMEI,
   * serial, SKU, barcode, invoice flag) are not copied.
   */
  async duplicate(id, actorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const sp = (await client.query(`SELECT * FROM shop_products WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0]
      if (!sp) throw httpError(404, 'Listing not found', 'NOT_FOUND')
      const prod = (await client.query(`SELECT * FROM products WHERE id = $1`, [sp.product_id])).rows[0]
      const suffix = crypto.randomBytes(3).toString('hex')

      const clone = async (table, row, overrides) => {
        // generated columns (e.g. products.thumbnail) are computed, never copied
        const generated = new Set((await client.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = $1 AND (is_generated = 'ALWAYS' OR identity_generation IS NOT NULL)`,
          [table])).rows.map((r) => r.column_name))
        const cols = Object.keys(row).filter((c) => !(c in overrides) && !generated.has(c) && !['id', 'created_at', 'updated_at', 'deleted_at'].includes(c))
        const allCols = [...cols, ...Object.keys(overrides)]
        const params = Object.values(overrides)
        const select = [...cols.map((c) => `"${c}"`), ...Object.keys(overrides).map((_, i) => `$${i + 2}`)]
        const { rows } = await client.query(
          `INSERT INTO ${table} (${allCols.map((c) => `"${c}"`).join(', ')})
           SELECT ${select.join(', ')} FROM ${table} WHERE id = $1 RETURNING id`, [row.id, ...params])
        return rows[0].id
      }

      const newProduct = await clone('products', prod, {
        name: `${prod.name} (copy)`.slice(0, 200),
        slug: `${String(prod.slug || 'product').slice(0, 70)}-${suffix}`,
        sku: null, barcode: null, imei: null, serial_number: null, has_invoice: false,
        total_sold: 0, avg_rating: 0, rating_count: 0, is_featured: false,
      })
      const newListing = await clone('shop_products', sp, {
        product_id: newProduct, seller_sku: null, sold_count: 0,
        approval_status: 'PENDING', approved_at: null, approved_by: null, rejection_reason: null,
        listing_status: 'PAUSED', is_available: false,
        qc_status: 'QC_PENDING', qc_mode: null, qc_score: null, qc_notes: null, qc_checked_at: null, qc_checked_by: null,
        merch_section: null, merch_starts_at: null, merch_ends_at: null, merch_position: 0, is_featured: false,
      })
      await client.query('COMMIT')
      void actorId
      return { id: newListing }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  /** Customer-facing: live listings of a section (approved, active, in stock, B2C, inside its window). */
  async publicSection(section, { limit = 20 } = {}) {
    if (!SECTIONS[section]) throw httpError(400, 'Unknown section', 'VALIDATION')
    const lim = Math.min(50, Math.max(1, Number(limit) || 20))
    const { rows } = await query(
      `SELECT sp.id, sp.shop_id, p.name, p.brand, p.condition, p.thumbnail_url,
              COALESCE(sp.sale_price, sp.price) AS price, sp.mrp, sp.stock_quantity AS stock, sp.merch_ends_at
         FROM shop_products sp JOIN products p ON p.id = sp.product_id
        WHERE sp.deleted_at IS NULL AND p.deleted_at IS NULL AND sp.merch_section = $1
          AND sp.approval_status = 'APPROVED' AND sp.listing_status = 'ACTIVE' AND sp.stock_quantity > 0 AND sp.sell_b2c = TRUE
          AND (sp.merch_starts_at IS NULL OR sp.merch_starts_at <= NOW())
          AND (sp.merch_ends_at IS NULL OR sp.merch_ends_at > NOW())
        ORDER BY sp.merch_position DESC, sp.created_at DESC LIMIT ${lim}`, [section])
    return {
      section, label: SECTIONS[section],
      data: rows.map((r) => ({ ...r, price: Number(r.price), mrp: r.mrp != null ? Number(r.mrp) : null })),
    }
  }
}
