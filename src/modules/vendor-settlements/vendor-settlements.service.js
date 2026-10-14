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
        { type: 'PLATFORM_CHARGE', amount: -Number(so.platform_charge || 0), key: `st:${sellerOrderId}:PCHG` },
        { type: 'TAX', amount: -Number(so.fee_tax_amount || 0), key: `st:${sellerOrderId}:FTAX` },
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
    // Same key as ads / b2b / auctions: every ledger writer serialises per vendor, so balance_after never goes stale.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settlement:${vendorId}`])
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

  /**
   * Vendor: move money from the settlement balance into the vendor user's Dealker wallet.
   * Auction registration fees and winning-bid payments are charged to that wallet, and the
   * vendor app has no card/UPI top-up, so this is how earnings fund auctions.
   */
  async transferToWallet(vendorId, userId, { amount, idempotencyKey = null }) {
    const value = Number(amount)
    if (!Number.isFinite(value) || value < 1) {
      const err = new Error('Enter an amount of at least ₹1'); err.statusCode = 422; err.code = 'VALIDATION'; throw err
    }
    if (value > 500000) {
      const err = new Error('Maximum transfer is ₹5,00,000'); err.statusCode = 422; err.code = 'VALIDATION'; throw err
    }
    const amountRounded = Number(value.toFixed(2))
    const key = idempotencyKey ? `wtx:${vendorId}:${String(idempotencyKey).slice(0, 60)}` : null
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (key) {
        const { rows } = await client.query('SELECT 1 FROM settlement_ledger WHERE idempotency_key = $1', [key])
        if (rows[0]) { await client.query('ROLLBACK'); return { replayed: true } }
      }
      const balance = await this.#vendorBalance(client, vendorId) // takes the settlement lock
      const { rows: holds } = await client.query(
        'SELECT 1 FROM settlement_holds WHERE vendor_id = $1 AND is_active = TRUE LIMIT 1', [vendorId]
      )
      if (holds[0]) {
        const err = new Error('Your settlements are on hold. Contact support.'); err.statusCode = 409; err.code = 'SETTLEMENT_HOLD'; throw err
      }
      if (balance < amountRounded) {
        const err = new Error('Not enough settlement balance to move this amount')
        err.statusCode = 402; err.code = 'INSUFFICIENT_SETTLEMENT'; err.required = amountRounded; err.balance = balance; err.shortfall = Number((amountRounded - balance).toFixed(2))
        throw err
      }
      const ref = key || `wtx:${vendorId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
      await client.query(
        `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key)
         VALUES ($1, 'ADJUSTMENT', $2, $3, 'Moved to Dealker wallet', $4, $5)`,
        [vendorId, -amountRounded, Number((balance - amountRounded).toFixed(2)), userId || null, ref]
      )
      await client.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING', [userId])
      const { rows: w } = await client.query('SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId])
      const credited = await client.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2 RETURNING balance', [amountRounded, w[0].id]
      )
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount, description, reference_id, balance_after, sub_type, source_id)
         VALUES ($1, 'CREDIT', $2, 'Moved from vendor settlement balance', $3, $4, 'VENDOR_TRANSFER', $5)`,
        [w[0].id, amountRounded, vendorId, credited.rows[0].balance, vendorId]
      )
      await client.query('COMMIT')
      return { moved: amountRounded, settlement_balance: Number((balance - amountRounded).toFixed(2)), wallet_balance: Number(credited.rows[0].balance) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async vendorSummary(vendorId) {
    // `available` is the true ledger balance: payouts are negative entries and must reduce what the vendor can spend
    // (it used to ignore them, so the app showed ₹1L+ more than the wallet could actually pay).
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(amount), 0) AS available,
         COALESCE(ABS(SUM(amount) FILTER (WHERE entry_type = 'PAYOUT')), 0) AS payout_debits,
         (SELECT COALESCE(SUM(p.amount), 0) FROM settlement_payouts p WHERE p.vendor_id = $1 AND p.status IN ('PENDING', 'PROCESSING')) AS payouts_in_progress,
         (SELECT COUNT(*) FROM seller_orders so WHERE so.vendor_id = $1 AND so.payout_status = 'PENDING' AND so.status = 'DELIVERED') AS pending_orders,
         (SELECT COALESCE(SUM(so.payable_to_seller), 0) FROM seller_orders so WHERE so.vendor_id = $1 AND so.payout_status = 'PENDING' AND so.status = 'DELIVERED') AS next_payout
       FROM settlement_ledger WHERE vendor_id = $1`,
      [vendorId]
    )
    return {
      available: Number(rows[0]?.available || 0),
      // The ledger debit happens when a payout is created, so money still on its way is not "paid" yet.
      paid: Math.max(0, Number((Number(rows[0]?.payout_debits || 0) - Number(rows[0]?.payouts_in_progress || 0)).toFixed(2))),
      payoutsInProgress: Number(rows[0]?.payouts_in_progress || 0),
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

  /** A vendor's own payouts (what Dealker sent or is sending to their bank). Internal notes and staff ids are never exposed. */
  async vendorPayouts(vendorId, { status = '', page = 1, limit = 20 } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20))
    const pg = Math.max(1, Number(page) || 1)
    const params = [vendorId]
    let where = 'WHERE p.vendor_id = $1'
    const st = String(status || '').toUpperCase()
    if (['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'].includes(st)) { params.push(st); where += ` AND p.status = $${params.length}` }
    const [{ rows }, { rows: agg }, { rows: cnt }] = await Promise.all([
      query(
        `SELECT p.id, p.payout_number, p.amount, p.status, p.utr_number, p.paid_at, p.created_at
           FROM settlement_payouts p ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${lim} OFFSET ${(pg - 1) * lim}`, params),
      query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid,
                COALESCE(SUM(amount) FILTER (WHERE status IN ('PENDING', 'PROCESSING')), 0) AS in_progress,
                COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
                COUNT(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::int AS in_progress_count
           FROM settlement_payouts WHERE vendor_id = $1`, [vendorId]),
      query(`SELECT COUNT(*)::int AS n FROM settlement_payouts p ${where}`, params),
    ])
    return {
      data: rows.map((r) => ({
        id: r.id, payout_number: r.payout_number, amount: Number(r.amount), status: r.status,
        utr_number: r.utr_number || null, paid_at: r.paid_at, created_at: r.created_at,
      })),
      summary: {
        paid: Number(agg[0].paid), in_progress: Number(agg[0].in_progress),
        paid_count: agg[0].paid_count, in_progress_count: agg[0].in_progress_count,
      },
      pagination: { page: pg, limit: lim, total: cnt[0].n },
    }
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
