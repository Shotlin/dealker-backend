/**
 * Vendor Wallet — reason-coded view over the append-only settlement ledger.
 *
 * Every row carries date, amount, type (CREDIT/DEBIT), reason, order, actor
 * and balance before/after. Manual entries are only possible with a reason
 * code AND a written reason; nothing is ever edited or deleted.
 *
 * @module modules/vendor-wallet/vendor-wallet.service
 */

import { query, getClient } from '../../config/database.js'

export const CREDIT_REASONS = [
  'ORDER_PAYMENT_RECEIVED', 'REFUND_ADJUSTMENT', 'CAMPAIGN_EARNING',
  'AUCTION_SALE', 'BONUS', 'SETTLEMENT', 'MANUAL_CREDIT',
]
export const DEBIT_REASONS = [
  'PLATFORM_COMMISSION', 'GST_TAX', 'PLATFORM_CHARGE', 'REFUND_ADJUSTMENT',
  'CANCELLATION_CHARGE', 'SHIPPING_CHARGE', 'PENALTY', 'MANUAL_DEBIT',
]

// Ledger entry_type that a manual entry with a given reason is stored as.
const ENTRY_TYPE_BY_REASON = {
  BONUS: 'BONUS', CAMPAIGN_EARNING: 'CAMPAIGN_EARNING', AUCTION_SALE: 'AUCTION_SALE',
  SETTLEMENT: 'SETTLEMENT', PENALTY: 'PENALTY', CANCELLATION_CHARGE: 'CANCELLATION_CHARGE',
  PLATFORM_CHARGE: 'PLATFORM_CHARGE', PLATFORM_COMMISSION: 'COMMISSION', GST_TAX: 'TAX',
  SHIPPING_CHARGE: 'LOGISTICS', REFUND_ADJUSTMENT: 'REFUND',
  MANUAL_CREDIT: 'MANUAL_CREDIT', MANUAL_DEBIT: 'MANUAL_DEBIT',
  ORDER_PAYMENT_RECEIVED: 'MANUAL_CREDIT',
}

function httpError(status, message, code) {
  const err = new Error(message)
  err.statusCode = status
  err.code = code
  return err
}

export class VendorWalletService {
  reasons() {
    return { credit: CREDIT_REASONS, debit: DEBIT_REASONS }
  }

  async overview() {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(amount), 0)                             AS total_balance,
         COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)   AS total_credits,
         COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0)  AS total_debits,
         COUNT(DISTINCT vendor_id)                            AS wallets
       FROM settlement_ledger`
    )
    const { rows: holds } = await query(
      `SELECT COUNT(DISTINCT vendor_id) AS held_vendors FROM settlement_holds WHERE is_active = TRUE`
    )
    const r = rows[0]
    return {
      totalBalance: Number(r.total_balance),
      totalCredits: Number(r.total_credits),
      totalDebits: Number(r.total_debits),
      wallets: Number(r.wallets),
      vendorsOnHold: Number(holds[0].held_vendors),
    }
  }

  async listWallets({ search = '', page = 1, limit = 20 } = {}) {
    const params = []
    let where = ''
    if (search) { params.push(`%${search}%`); where = `WHERE v.name ILIKE $1` }
    const offset = (page - 1) * limit
    const { rows } = await query(
      `SELECT v.id AS vendor_id, v.name AS business_name,
              COALESCE(SUM(l.amount), 0)                            AS balance,
              COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0)  AS total_credits,
              COALESCE(-SUM(l.amount) FILTER (WHERE l.amount < 0), 0) AS total_debits,
              MAX(l.created_at)                                     AS last_activity,
              EXISTS (SELECT 1 FROM settlement_holds h WHERE h.vendor_id = v.id AND h.is_active) AS on_hold,
              COUNT(*) OVER() AS total_count
         FROM vendors v
         LEFT JOIN settlement_ledger l ON l.vendor_id = v.id
         ${where}
        GROUP BY v.id
        ORDER BY balance DESC, v.name
        LIMIT ${limit} OFFSET ${offset}`,
      params
    )
    const total = Number(rows[0]?.total_count || 0)
    return {
      success: true,
      data: rows.map(({ total_count, ...r }) => ({
        ...r,
        balance: Number(r.balance), total_credits: Number(r.total_credits), total_debits: Number(r.total_debits),
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async transactions(vendorId, { direction = '', reasonCode = '', from = '', to = '', page = 1, limit = 25 } = {}) {
    const { rows: v } = await query(`SELECT id, name FROM vendors WHERE id = $1`, [vendorId])
    if (!v[0]) throw httpError(404, 'Vendor not found', 'NOT_FOUND')

    const params = [vendorId]
    const where = ['l.vendor_id = $1']
    if (direction === 'CREDIT') where.push('l.amount > 0')
    if (direction === 'DEBIT') where.push('l.amount < 0')
    if (reasonCode) { params.push(reasonCode); where.push(`l.reason_code = $${params.length}`) }
    if (from) { params.push(from); where.push(`l.created_at >= $${params.length}::timestamp`) }
    if (to) { params.push(to); where.push(`l.created_at < ($${params.length}::date + 1)`) }
    const offset = (page - 1) * limit

    const { rows } = await query(
      `SELECT l.id, l.created_at, l.amount, l.entry_type, l.reason_code, l.reason,
              l.balance_before, l.balance_after, l.reference_type, l.reference_id,
              l.seller_order_id, so.seller_order_number, o.id AS order_id, o.order_number,
              u.name AS actor_name, l.actor_id,
              COUNT(*) OVER() AS total_count
         FROM settlement_ledger l
         LEFT JOIN seller_orders so ON so.id = l.seller_order_id
         LEFT JOIN orders o ON o.id = so.order_id
         LEFT JOIN users u ON u.id = l.actor_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    )
    const total = Number(rows[0]?.total_count || 0)
    const balance = Number((await query(`SELECT COALESCE(SUM(amount),0) AS b FROM settlement_ledger WHERE vendor_id = $1`, [vendorId])).rows[0].b)
    return {
      success: true,
      vendor: { id: v[0].id, businessName: v[0].name, balance },
      data: rows.map(({ total_count, amount, ...r }) => ({
        ...r,
        amount: Number(amount),
        type: Number(amount) > 0 ? 'CREDIT' : 'DEBIT',
        balance_before: Number(r.balance_before),
        balance_after: Number(r.balance_after),
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  /**
   * Manual credit/debit. A reason code AND a written reason (≥ 5 chars) are
   * mandatory. Serialised per vendor so balance_after is always consistent.
   */
  async addManualEntry(vendorId, { direction, reasonCode, reason, amount, orderNumber }, actorId) {
    const dir = String(direction || '').toUpperCase()
    if (!['CREDIT', 'DEBIT'].includes(dir)) throw httpError(400, 'direction must be CREDIT or DEBIT', 'VALIDATION')
    const allowed = dir === 'CREDIT' ? CREDIT_REASONS : DEBIT_REASONS
    if (!allowed.includes(reasonCode)) {
      throw httpError(400, `reasonCode for a ${dir.toLowerCase()} must be one of: ${allowed.join(', ')}`, 'VALIDATION')
    }
    const text = String(reason || '').trim()
    if (text.length < 5) throw httpError(400, 'A written reason (at least 5 characters) is required', 'REASON_REQUIRED')
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) throw httpError(400, 'amount must be greater than 0', 'VALIDATION')
    const signed = Number((dir === 'CREDIT' ? value : -value).toFixed(2))

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: vendor } = await client.query(`SELECT id FROM vendors WHERE id = $1`, [vendorId])
      if (!vendor[0]) throw httpError(404, 'Vendor not found', 'NOT_FOUND')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vendor-wallet:${vendorId}`])

      let sellerOrderId = null
      if (orderNumber) {
        const { rows: so } = await client.query(
          `SELECT so.id FROM seller_orders so JOIN orders o ON o.id = so.order_id
            WHERE so.vendor_id = $1 AND (o.order_number = $2 OR so.seller_order_number = $2) LIMIT 1`,
          [vendorId, String(orderNumber).trim()]
        )
        if (!so[0]) throw httpError(400, 'That order number does not belong to this vendor', 'VALIDATION')
        sellerOrderId = so[0].id
      }

      const before = Number((await client.query(
        `SELECT COALESCE(SUM(amount),0) AS b FROM settlement_ledger WHERE vendor_id = $1`, [vendorId]
      )).rows[0].b)
      const after = Number((before + signed).toFixed(2))
      if (after < 0) throw httpError(409, `Debit exceeds the wallet balance (₹${before.toFixed(2)})`, 'INSUFFICIENT_BALANCE')

      const { rows } = await client.query(
        `INSERT INTO settlement_ledger
           (seller_order_id, vendor_id, entry_type, amount, balance_before, balance_after,
            reason_code, reason, actor_id, reference_type, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ADMIN_MANUAL',$10) RETURNING id`,
        [sellerOrderId, vendorId, ENTRY_TYPE_BY_REASON[reasonCode], signed, before, after,
         reasonCode, text, actorId || null,
         `vw:manual:${vendorId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`]
      )
      await client.query('COMMIT')
      return { id: rows[0].id, balanceBefore: before, balanceAfter: after }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}
