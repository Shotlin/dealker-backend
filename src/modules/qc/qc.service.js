/**
 * QC service — manual decisions, automatic runs, rules/settings, queue.
 * Decisions are appended to listing_qc_events (never edited).
 *
 * @module modules/qc/qc.service
 */

import { query, getClient } from '../../config/database.js'
import { evaluateQc, RULE_KEYS } from './qc.engine.js'

export const QC_STATUSES = ['QC_PENDING', 'QC_PASSED', 'QC_FAILED', 'QC_RECHECK']

const httpError = (statusCode, message, code = 'QC_ERROR') => Object.assign(new Error(message), { statusCode, code })

const QUEUE_FROM = `
  FROM shop_products sp
  JOIN products p ON p.id = sp.product_id
  LEFT JOIN vendors v ON v.id = p.owner_vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
 WHERE sp.deleted_at IS NULL AND p.deleted_at IS NULL`

export class QcService {
  async getSettings() {
    const { rows } = await query(`SELECT * FROM qc_settings WHERE id = 1`)
    const s = rows[0]
    return { autoQcEnabled: s.auto_qc_enabled, passThreshold: s.pass_threshold, requirePassToPublish: s.require_pass_to_publish }
  }

  async getRules() {
    const { rows } = await query(`SELECT * FROM qc_rules ORDER BY sort_order, key`)
    return rows
  }

  async updateConfig({ settings, rules }, actorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (settings) {
        const t = settings.passThreshold
        if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= 100)) throw httpError(400, 'passThreshold must be a whole number from 1 to 100', 'VALIDATION')
        await client.query(
          `UPDATE qc_settings SET
             auto_qc_enabled = COALESCE($1, auto_qc_enabled),
             pass_threshold = COALESCE($2, pass_threshold),
             require_pass_to_publish = COALESCE($3, require_pass_to_publish),
             updated_at = NOW() WHERE id = 1`,
          [typeof settings.autoQcEnabled === 'boolean' ? settings.autoQcEnabled : null, t ?? null,
            typeof settings.requirePassToPublish === 'boolean' ? settings.requirePassToPublish : null]
        )
      }
      for (const r of rules || []) {
        if (!RULE_KEYS.includes(r.key)) throw httpError(400, `Unknown rule ${r.key}`, 'VALIDATION')
        if (r.weight !== undefined && !(Number.isInteger(r.weight) && r.weight >= 0 && r.weight <= 100)) {
          throw httpError(400, `${r.key}: weight must be a whole number from 0 to 100`, 'VALIDATION')
        }
        if (r.params !== undefined && (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params))) {
          throw httpError(400, `${r.key}: params must be an object`, 'VALIDATION')
        }
        await client.query(
          `UPDATE qc_rules SET
             enabled = COALESCE($2, enabled), required = COALESCE($3, required),
             weight = COALESCE($4, weight), params = COALESCE($5::jsonb, params), updated_at = NOW()
           WHERE key = $1`,
          [r.key, typeof r.enabled === 'boolean' ? r.enabled : null, typeof r.required === 'boolean' ? r.required : null,
            r.weight ?? null, r.params ? JSON.stringify(r.params) : null]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    void actorId
    return { settings: await this.getSettings(), rules: await this.getRules() }
  }

  async stats() {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE sp.qc_status = 'QC_PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE sp.qc_status = 'QC_PASSED')::int AS passed,
              COUNT(*) FILTER (WHERE sp.qc_status = 'QC_FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE sp.qc_status = 'QC_RECHECK')::int AS recheck
         ${QUEUE_FROM}`
    )
    return rows[0]
  }

  async queue({ status = '', mode = '', search = '', page = 1, limit = 25 } = {}) {
    const where = []
    const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (status) where.push(`sp.qc_status = ${p(status)}`)
    if (mode) where.push(`sp.qc_mode = ${p(mode)}`)
    if (search) { const s = p(`%${search}%`); where.push(`(p.name ILIKE ${s} OR p.brand ILIKE ${s} OR p.imei ILIKE ${s} OR v.name ILIKE ${s})`) }
    const w = where.length ? ` AND ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Math.max(1, Number(limit) || 25))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const total = (await query(`SELECT COUNT(*)::int n ${QUEUE_FROM}${w}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT sp.id, p.name, p.brand, p.condition, p.thumbnail_url, p.imei,
              COALESCE(v.name, 'Dealker') AS owner_name, c.name AS category_name,
              COALESCE(sp.sale_price, sp.price) AS price, sp.approval_status,
              sp.qc_status, sp.qc_mode, sp.qc_score, sp.qc_notes, sp.qc_checked_at, sp.created_at,
              (SELECT COUNT(*)::int FROM listing_invoices i WHERE i.shop_product_id = sp.id AND i.status <> 'REJECTED') AS invoice_count
         ${QUEUE_FROM}${w}
        ORDER BY (sp.qc_status IN ('QC_PENDING','QC_RECHECK')) DESC, sp.created_at DESC
        LIMIT ${lim} OFFSET ${off}`, params)
    return {
      data: rows.map((r) => ({ ...r, price: Number(r.price) })),
      meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) },
    }
  }

  /** Load everything the engine needs for one listing. */
  async #context(listingId, runner = query) {
    const { rows } = await runner(
      `SELECT sp.id, sp.qc_status, sp.qc_mode, sp.price AS sp_price, sp.sale_price, sp.mrp,
              p.name, p.condition, p.condition_notes, p.battery_health, p.serial_number, p.imei,
              p.warranty_info, p.images, p.owner_vendor_id, c.name AS category_name,
              v.status AS vendor_status
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN vendors v ON v.id = p.owner_vendor_id
        WHERE sp.id = $1 AND sp.deleted_at IS NULL`, [listingId])
    const r = rows[0]
    if (!r) throw httpError(404, 'Listing not found', 'NOT_FOUND')
    const inv = (await runner(
      `SELECT status, imei_serial, purchase_amount FROM listing_invoices WHERE shop_product_id = $1`, [listingId]
    )).rows
    return {
      current: { status: r.qc_status, mode: r.qc_mode },
      ctx: {
        listing: {
          price: Number(r.sale_price ?? r.sp_price), mrp: r.mrp != null ? Number(r.mrp) : null,
          imageCount: Array.isArray(r.images) ? r.images.length : 0,
          condition: r.condition, conditionNotes: r.condition_notes, batteryHealth: r.battery_health,
          serialNumber: r.serial_number, imei: r.imei, warrantyInfo: r.warranty_info,
          categoryName: r.category_name,
        },
        invoices: inv,
        vendor: r.owner_vendor_id ? { status: r.vendor_status } : null,
      },
    }
  }

  async #record(client, listingId, { toStatus, fromStatus, mode, score, notes, results, actorId }) {
    await client.query(
      `UPDATE shop_products SET qc_status = $2, qc_mode = $3, qc_score = $4, qc_notes = $5,
              qc_checked_at = NOW(), qc_checked_by = $6, updated_at = NOW() WHERE id = $1`,
      [listingId, toStatus, mode === 'RESET' ? null : mode, score ?? null, notes || null, actorId || null]
    )
    await client.query(
      `INSERT INTO listing_qc_events (shop_product_id, from_status, to_status, mode, score, notes, results, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [listingId, fromStatus, toStatus, mode, score ?? null, notes || null, results ? JSON.stringify(results) : null, actorId || null]
    )
  }

  /** Admin's manual decision. FAILED / RECHECK need a note the seller can act on. */
  async setManual(listingId, status, notes, actorId) {
    if (!QC_STATUSES.includes(status)) throw httpError(400, `status must be one of ${QC_STATUSES.join(', ')}`, 'VALIDATION')
    const text = String(notes || '').trim()
    if (['QC_FAILED', 'QC_RECHECK'].includes(status) && text.length < 5) {
      throw httpError(400, 'Tell the seller what to fix (at least 5 characters)', 'NOTE_REQUIRED')
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { current } = await this.#context(listingId, client.query.bind(client))
      await this.#record(client, listingId, {
        toStatus: status, fromStatus: current.status, mode: 'MANUAL', notes: text, actorId,
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return this.detail(listingId)
  }

  /** Evaluate the rules without saving (preview used by the UI). */
  async evaluate(listingId) {
    const [{ ctx }, rules, settings] = await Promise.all([this.#context(listingId), this.getRules(), this.getSettings()])
    return evaluateQc(ctx, rules, settings)
  }

  /**
   * Run automatic QC and save the outcome. `force` is true for an explicit
   * admin click; background triggers never overwrite a MANUAL decision.
   */
  async runAuto(listingId, actorId = null, { force = true } = {}) {
    const [{ ctx, current }, rules, settings] = await Promise.all([this.#context(listingId), this.getRules(), this.getSettings()])
    if (!force && current.mode === 'MANUAL' && current.status !== 'QC_PENDING') {
      return { skipped: true, reason: 'A manual QC decision is in place' }
    }
    const out = evaluateQc(ctx, rules, settings)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.#record(client, listingId, {
        toStatus: out.status, fromStatus: current.status, mode: 'AUTO', score: out.score,
        notes: out.summary || 'All automatic checks passed', results: out.results, actorId,
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return { skipped: false, ...out }
  }

  /** Background trigger (listing created/edited, invoice changed). Never throws. */
  async autoIfEnabled(listingId) {
    try {
      const s = await this.getSettings()
      if (!s.autoQcEnabled) return null
      return await this.runAuto(listingId, null, { force: false })
    } catch {
      return null
    }
  }

  /** A seller edited listing content: the earlier decision no longer applies. */
  async reset(listingId, reason = 'Listing content changed — QC needs to run again') {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { current } = await this.#context(listingId, client.query.bind(client))
      if (current.status !== 'QC_PENDING') {
        await this.#record(client, listingId, { toStatus: 'QC_PENDING', fromStatus: current.status, mode: 'RESET', notes: reason })
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  /** Run auto QC over the listings waiting for QC (bounded). */
  async runAutoBulk(actorId, { statuses = ['QC_PENDING'], limit = 200 } = {}) {
    const { rows } = await query(
      `SELECT sp.id FROM shop_products sp WHERE sp.deleted_at IS NULL AND sp.qc_status = ANY($1::text[])
        ORDER BY sp.created_at LIMIT $2`, [statuses, Math.min(500, limit)])
    const summary = { processed: 0, QC_PASSED: 0, QC_FAILED: 0, QC_RECHECK: 0, errors: 0 }
    for (const r of rows) {
      try {
        const out = await this.runAuto(r.id, actorId)
        summary.processed += 1
        if (out.status) summary[out.status] += 1
      } catch {
        summary.errors += 1
      }
    }
    return summary
  }

  async detail(listingId) {
    const { rows } = await query(
      `SELECT sp.id, sp.approval_status, sp.qc_status, sp.qc_mode, sp.qc_score, sp.qc_notes, sp.qc_checked_at,
              u.name AS qc_checked_by_name, p.name, p.brand, p.condition, p.imei, p.serial_number, p.thumbnail_url,
              COALESCE(v.name, 'Dealker') AS owner_name, COALESCE(sp.sale_price, sp.price) AS price, sp.mrp
         FROM shop_products sp JOIN products p ON p.id = sp.product_id
         LEFT JOIN vendors v ON v.id = p.owner_vendor_id
         LEFT JOIN users u ON u.id = sp.qc_checked_by
        WHERE sp.id = $1 AND sp.deleted_at IS NULL`, [listingId])
    if (!rows[0]) throw httpError(404, 'Listing not found', 'NOT_FOUND')
    const events = (await query(
      `SELECT e.id, e.from_status, e.to_status, e.mode, e.score, e.notes, e.results, e.created_at, u.name AS actor_name
         FROM listing_qc_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.shop_product_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 30`, [listingId])).rows
    const live = await this.evaluate(listingId)
    const r = rows[0]
    return { ...r, price: Number(r.price), mrp: r.mrp != null ? Number(r.mrp) : null, events, live }
  }

  /**
   * Customer-facing QC report for a product page — only for a listing that has PASSED QC (customers never see
   * failures). Built from real data: the latest QC run's rule results (IMEI, photos, invoice, condition, price),
   * plus battery health / condition recorded on the product. Returns null when there is nothing to show.
   */
  async publicReport(productId) {
    const { rows } = await query(
      `SELECT sp.id, sp.qc_score, sp.qc_checked_at, p.condition, p.battery_health
         FROM shop_products sp JOIN products p ON p.id = sp.product_id
        WHERE p.id = $1 AND sp.deleted_at IS NULL AND sp.approval_status = 'APPROVED' AND sp.qc_status = 'QC_PASSED'
        ORDER BY sp.qc_checked_at DESC NULLS LAST LIMIT 1`, [productId])
    const r = rows[0]
    if (!r) return null
    const ev = (await query(
      `SELECT results FROM listing_qc_events WHERE shop_product_id = $1 AND to_status = 'QC_PASSED' AND results IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`, [r.id])).rows[0]
    const checks = []
    for (const x of Array.isArray(ev?.results) ? ev.results : []) {
      if (x.status === 'SKIP') continue
      checks.push({ label: x.label, value: x.detail || (x.status === 'PASS' ? 'Passed' : 'Checked'), ok: x.status === 'PASS' })
    }
    if (r.battery_health != null) checks.push({ label: 'Battery', value: `Health ${r.battery_health}%`, ok: Number(r.battery_health) >= 80 })
    if (!checks.length) return null
    return { status: 'QC_PASSED', score: r.qc_score, checkedAt: r.qc_checked_at, condition: r.condition, checks }
  }
}
