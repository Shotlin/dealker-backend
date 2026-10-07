/**
 * Vendor Settlements Service — append-only settlement ledger (spec §23).
 *
 * For every seller order:
 *   GMV − seller-funded discount ± platform discount reimbursement
 *       − commission − logistics allocation − refunds/penalties + incentives
 *       = net vendor payable
 *
 * The ledger is authoritative; `seller_orders.payable_to_seller` is a cache.
 * Every entry carries a UNIQUE idempotency key so re-posting an order is a
 * no-op, and balances are reconstructable by summing entries.
 *
 * @module modules/vendor-settlements/vendor-settlements.service
 */

import { query, getClient } from '../../config/database.js'

export class VendorSettlementsService {
  /**
   * Post the financial entries for a seller order (idempotent). Called when
   * an order is confirmed/paid and amended by refund/adjustment entries.
   */
  async postSellerOrderEntries(sellerOrderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT * FROM seller_orders WHERE id = $1 FOR UPDATE`, [sellerOrderId]
      )
      const so = rows[0]
      if (!so) {
        const err = new Error('Seller order not found')
        err.code = 'NOT_FOUND'
        throw err
      }
      const vendorId = so.vendor_id
      if (!vendorId) {
        const err = new Error('Seller order has no vendor — nothing to settle')
        err.code = 'NO_VENDOR'
        throw err
      }

      const entries = [
        { type: 'GROSS_SALES', amount: Number(so.item_subtotal || 0), key: `st:${sellerOrderId}:GROSS` },
        { type: 'SELLER_DISCOUNT', amount: -Number(so.seller_discount || 0), key: `st:${sellerOrderId}:SDISC` },
        { type: 'PLATFORM_DISCOUNT', amount: Number(so.platform_discount || 0), key: `st:${sellerOrderId}:PDISC` },
        { type: 'COMMISSION', amount: -Number(so.commission_amount || 0), key: `st:${sellerOrderId}:COMM` },
        { type: 'LOGISTICS', amount: -Number(so.shipping_charge || 0), key: `st:${sellerOrderId}:LOG` },
      ].filter((e) => e.amount !== 0)

      let balance = await this.#vendorBalance(client, vendorId)
      for (const entry of entries) {
        const { rows: dupe } = await client.query(
          `SELECT id FROM settlement_ledger WHERE idempotency_key = $1 LIMIT 1`, [entry.key]
        )
        if (dupe[0]) continue
        balance = Number((balance + entry.amount).toFixed(2))
        await client.query(
          `INSERT INTO settlement_ledger (seller_order_id, vendor_id, entry_type, amount, balance_after, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sellerOrderId, vendorId, entry.type, entry.amount, balance, entry.key]
        )
      }
      // Cache the derived payable on the seller order (ledger is source of truth).
      const { rows: netRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS net FROM settlement_ledger
          WHERE seller_order_id = $1 AND entry_type NOT IN ('PAYOUT')`,
        [sellerOrderId]
      )
      await client.query(
        `UPDATE seller_orders SET payable_to_seller = $2, updated_at = NOW() WHERE id = $1`,
        [sellerOrderId, Math.max(0, Number(netRows[0]?.net || 0))]
      )
      await client.query('COMMIT')
      return { sellerOrderId, net: Number(netRows[0]?.net || 0) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async #vendorBalance(client, vendorId) {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS bal FROM settlement_ledger WHERE vendor_id = $1`,
      [vendorId]
    )
    return Number(rows[0]?.bal || 0)
  }

  /** Refund/return deduction against a seller order (negative entry). */
  async postRefund(sellerOrderId, amount, reason, actorId = null) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT * FROM seller_orders WHERE id = $1 FOR UPDATE`, [sellerOrderId])
      const so = rows[0]
      if (!so) { const err = new Error('Seller order not found'); err.code = 'NOT_FOUND'; throw err }
      const key = `st:${sellerOrderId}:REFUND:${reason || 'default'}`
      const { rows: dupe } = await client.query(`SELECT id FROM settlement_ledger WHERE idempotency_key = $1 LIMIT 1`, [key])
      if (!dupe[0]) {
        const balance = await this.#vendorBalance(client, so.vendor_id)
        const amt = -Math.abs(Number(amount || 0))
        await client.query(
          `INSERT INTO settlement_ledger (seller_order_id, vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key)
           VALUES ($1, $2, 'REFUND', $3, $4, $5, $6, $7)`,
          [sellerOrderId, so.vendor_id, amt, Number((balance + amt).toFixed(2)), reason, actorId, key]
        )
      }
      await client.query('COMMIT')
      return { success: true }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async adminAdjust(vendorId, amount, reason, actorId = null) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const balance = await this.#vendorBalance(client, vendorId)
      await client.query(
        `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key)
         VALUES ($1, 'ADJUSTMENT', $2, $3, $4, $5, $6)`,
        [vendorId, amount, Number((balance + Number(amount)).toFixed(2)), reason, actorId,
         `st:adj:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async vendorSummary(vendorId) {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE entry_type NOT IN ('PAYOUT')), 0) AS available,
         COALESCE(ABS(SUM(amount) FILTER (WHERE entry_type = 'PAYOUT')), 0) AS paid,
         (SELECT COUNT(*) FROM seller_orders so WHERE so.vendor_id = $1 AND so.payout_status = 'PENDING' AND so.status = 'DELIVERED') AS pending_orders,
         (SELECT COALESCE(SUM(so.payable_to_seller), 0) FROM seller_orders so WHERE so.vendor_id = $1 AND so.payout_status = 'PENDING' AND so.status = 'DELIVERED') AS next_payout
       FROM settlement_ledger WHERE vendor_id = $1`,
      [vendorId]
    )
    return {
      available: Number(rows[0]?.available || 0),
      paid: Number(rows[0]?.paid || 0),
      pendingOrders: Number(rows[0]?.pending_orders || 0),
      nextPayout: Number(rows[0]?.next_payout || 0),
    }
  }

  async vendorStatement(vendorId, { page = 1, limit = 20, entryType = '' } = {}) {
    const params = [vendorId]
    let where = ''
    if (entryType) {
      params.push(entryType)
      where = `AND l.entry_type = $${params.length}`
    }
    const offset = (Math.max(1, page) - 1) * limit
    const { rows } = await query(
      `SELECT l.*, so.seller_order_number, o.order_number AS parent_order_number
         FROM settlement_ledger l
         LEFT JOIN seller_orders so ON so.id = l.seller_order_id
         LEFT JOIN orders o ON o.id = so.order_id
        WHERE l.vendor_id = $1 ${where}
        ORDER BY l.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total FROM settlement_ledger l WHERE l.vendor_id = $1 ${where}`,
      params
    )
    return { data: rows, summary: await this.vendorSummary(vendorId), pagination: { page: Number(page), limit, total: Number(count[0]?.total || 0) } }
  }

  async adminOverview() {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(DISTINCT vendor_id) FROM settlement_ledger) AS vendors_with_activity,
         ABS(COALESCE(SUM(amount) FILTER (WHERE entry_type = 'COMMISSION'), 0)) AS commission_earned,
         COALESCE(SUM(amount) FILTER (WHERE entry_type = 'GROSS_SALES'), 0) AS gmv_posted,
         COALESCE(ABS(SUM(amount) FILTER (WHERE entry_type = 'PAYOUT')), 0) AS total_paid_out,
         COALESCE(SUM(amount), 0) AS total_liability
       FROM settlement_ledger`
    )
    return {
      vendorsWithActivity: Number(rows[0]?.vendors_with_activity || 0),
      commissionEarned: Number(rows[0]?.commission_earned || 0),
      gmvPosted: Number(rows[0]?.gmv_posted || 0),
      totalPaidOut: Number(rows[0]?.total_paid_out || 0),
      totalLiability: Number(rows[0]?.total_liability || 0),
    }
  }

  async createPayout(vendorId, { amount, notes, createdBy } = {}) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: vendorCheck } = await client.query(`SELECT id FROM vendors WHERE id = $1`, [vendorId])
      if (!vendorCheck[0]) { const err = new Error('Vendor not found'); err.code = 'NOT_FOUND'; throw err }
      const balance = await this.#vendorBalance(client, vendorId)
      const payoutAmount = Math.min(Number(amount || balance), balance)
      if (payoutAmount <= 0) {
        const err = new Error('Nothing to pay out for this vendor')
        err.code = 'NOTHING_TO_PAY'
        throw err
      }
      const { rows: seq } = await client.query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(payout_number, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM settlement_payouts`
      )
      const payoutNumber = `PO-${String(seq[0].n).padStart(6, '0')}`
      const { rows: payout } = await client.query(
        `INSERT INTO settlement_payouts (vendor_id, payout_number, amount, status, notes, created_by)
         VALUES ($1, $2, $3, 'PROCESSING', $4, $5) RETURNING *`,
        [vendorId, payoutNumber, payoutAmount, notes, createdBy]
      )
      const { rows: bal } = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS bal FROM settlement_ledger WHERE vendor_id = $1`, [vendorId]
      )
      await client.query(
        `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key)
         VALUES ($1, 'PAYOUT', $2, $3, $4, $5, $6)`,
        [vendorId, -payoutAmount, Number((Number(bal[0].bal) - payoutAmount).toFixed(2)),
         `Payout ${payoutNumber}`, createdBy, `payout:${payout[0].id}`]
      )
      await client.query('COMMIT')
      return payout[0]
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async markPayoutPaid(payoutId, { utrNumber, actorId } = {}) {
    const { rows } = await query(
      `UPDATE settlement_payouts SET status = 'PAID', utr_number = COALESCE($2, utr_number), paid_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [payoutId, utrNumber || null]
    )
    return rows[0] || null
  }

  async listPayouts({ vendorId = null, page = 1, limit = 20 } = {}) {
    const params = []
    let where = ''
    if (vendorId) { params.push(vendorId); where = `WHERE p.vendor_id = $${params.length}` }
    const offset = (Math.max(1, page) - 1) * limit
    const { rows } = await query(
      `SELECT p.*, v.name AS vendor_name FROM settlement_payouts p JOIN vendors v ON v.id = p.vendor_id
        ${where} ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    return { data: rows, pagination: { page: Number(page), limit } }
  }
}
