import { query, getClient } from '../../config/database.js'
import { refundCaseService } from './refund-case.service.js'
import { ReturnJourneyService } from './return-journey.service.js'

/**
 * Admin refund-request review — mounted at /api/v1/admin/refund-requests.
 * Maps the refund_requests table onto the shape the dashboard's Returns page
 * expects (see dealker-dashboard/src/types/refund-request.types.ts).
 */
const SELECT = `
  SELECT r.*, o.order_number, o.total_payable AS order_total, o.wallet_amount AS order_wallet_amount,
         u.name AS customer_name, u.phone AS customer_phone, io.name AS investigation_owner_name
    FROM refund_requests r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN users u ON u.id = r.customer_id
    LEFT JOIN users io ON io.id = r.investigation_owner`

const toView = (r) => ({
  id: r.id,
  order_id: r.order_id,
  order_number: r.order_number,
  user_id: r.customer_id,
  customer_name: r.customer_name,
  customer_phone: r.customer_phone,
  item_scope: r.scope === 'ITEMS' ? 'SPECIFIC' : 'ALL',
  items: r.items,
  description: r.reason,
  status: r.status === 'PROCESSING' ? 'PENDING' : r.status,
  admin_note: r.admin_notes,
  processed_by: r.resolved_by,
  processed_at: r.resolved_at,
  refund_amount: r.resolved_amount != null ? Number(r.resolved_amount) : null,
  refund_to: r.status === 'APPROVED' ? (r.refund_destination === 'WALLET' ? 'wallet' : 'original') : null,
  total_amount: Number(r.order_total),
  wallet_amount_used: Number(r.order_wallet_amount || 0),
  investigation_status: r.investigation_status,
  investigation_owner_name: r.investigation_owner_name ?? null,
  investigation_due_at: r.investigation_due_at ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
})

export default async function adminRefundRequestRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { preHandler: pre }, async (req) => {
    const { page = 1, limit = 20, status, search, startDate, endDate } = req.query || {}
    const where = []
    const params = []
    if (status) { params.push(status); where.push(`r.status = $${params.length}`) }
    if (search) { params.push(`%${search}%`); where.push(`(o.order_number ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`) }
    if (startDate) { params.push(startDate); where.push(`r.created_at >= $${params.length}`) }
    if (endDate) { params.push(endDate); where.push(`r.created_at < ($${params.length}::date + interval '1 day')`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Number(limit) || 20)
    const off = (Math.max(1, Number(page)) - 1) * lim
    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int AS n FROM refund_requests r JOIN orders o ON o.id = r.order_id LEFT JOIN users u ON u.id = r.customer_id ${w}`, params)
    const { rows } = await query(`${SELECT} ${w} ORDER BY r.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    const total = cnt[0].n
    return {
      success: true,
      data: { requests: rows.map(toView), pagination: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) } },
    }
  })

  fastify.get('/:id', { preHandler: pre }, async (req, reply) => {
    const { rows } = await query(`${SELECT} WHERE r.id = $1`, [req.params.id])
    if (!rows[0]) return reply.code(404).send({ success: false, message: 'Refund request not found' })
    return { success: true, data: toView(rows[0]) }
  })

  fastify.post('/:id/approve', { preHandler: pre }, async (req, reply) => {
    const refundTo = req.body?.refundTo === 'wallet' ? 'WALLET' : 'RAZORPAY'
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = (await client.query(`SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0]
      if (!r) { await client.query('ROLLBACK'); return reply.code(404).send({ success: false, message: 'Refund request not found' }) }
      if (!['PENDING', 'PROCESSING'].includes(r.status)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ success: false, message: `Request already ${r.status.toLowerCase()}` })
      }
      // After a quality check the customer may have accepted a lower price: refund exactly that.
      // Throws 409 QC_PRICE_PENDING while the customer still has to answer.
      const qcAmount = await new ReturnJourneyService().approvalAmount(r.id)
      const amount = qcAmount != null ? qcAmount : Number(r.computed_amount)
      await client.query(
        `UPDATE refund_requests SET status = 'APPROVED', refund_destination = $2, resolved_amount = $3, resolved_by = $4,
                resolved_at = NOW(), refunded_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [r.id, refundTo, amount, req.user?.id ?? null])
      if (refundTo === 'WALLET') {
        await client.query(`UPDATE users SET wallet_balance = COALESCE(wallet_balance,0) + $2 WHERE id = $1`, [r.customer_id, amount])
        await client.query(`UPDATE wallets SET balance = COALESCE(balance,0) + $2, updated_at = NOW() WHERE user_id = $1`, [r.customer_id, amount])
      }
      // Seller side: which parcels does this return touch, and what share of each?
      const sellers = (await client.query(
        `SELECT so.id, so.vendor_id, so.seller_order_number, so.commission_rate, so.item_subtotal, so.status
           FROM seller_orders so WHERE so.order_id = $1 AND so.status <> 'CANCELLED'`, [r.order_id])).rows
      const itemTotals = r.scope === 'ITEMS' && Array.isArray(r.items) ? r.items : null
      for (const so of sellers) {
        let refundedGross
        if (!itemTotals) refundedGross = Number(so.item_subtotal)
        else {
          const ids = itemTotals.map((i) => i.orderItemId).filter(Boolean)
          const rows = (await client.query(`SELECT subtotal FROM order_items WHERE seller_order_id = $1 AND id = ANY($2::uuid[])`, [so.id, ids])).rows
          refundedGross = rows.reduce((t, x) => t + Number(x.subtotal), 0)
        }
        if (!refundedGross || !so.vendor_id) continue
        const net = Math.round(refundedGross * (1 - Number(so.commission_rate) / 100) * 100) / 100
        const full = Math.abs(refundedGross - Number(so.item_subtotal)) < 0.01
        await client.query(`UPDATE seller_orders SET status = $2, payout_status = CASE WHEN $3 THEN 'REVERSED' ELSE payout_status END, updated_at = NOW() WHERE id = $1`, [so.id, full ? 'RETURNED' : so.status, full])
        const dupe = await client.query(`SELECT 1 FROM settlement_ledger WHERE idempotency_key = $1`, [`refund:${r.id}:${so.id}`])
        if (!dupe.rows[0] && net > 0) {
          const bal = Number((await client.query(`SELECT COALESCE(SUM(amount),0) b FROM settlement_ledger WHERE vendor_id = $1`, [so.vendor_id])).rows[0].b)
          await client.query(
            `INSERT INTO settlement_ledger (seller_order_id, vendor_id, entry_type, amount, balance_after, reason, idempotency_key) VALUES ($1,$2,'REFUND',$3,$4,$5,$6)`,
            [so.id, so.vendor_id, -net, Math.round((bal - net) * 100) / 100, `Customer refund for ${so.seller_order_number}`, `refund:${r.id}:${so.id}`])
        }
      }
      const fullOrder = r.scope === 'FULL_ORDER'
      await client.query(`UPDATE orders SET payment_status = 'REFUNDED', status = CASE WHEN $2 THEN 'REFUNDED' ELSE status END, updated_at = NOW() WHERE id = $1`, [r.order_id, fullOrder])
      await refundCaseService.recordDecision(client, r.id, { approved: true, amount, destination: refundTo, note: req.body?.note, actorId: req.user?.id ?? null })
      if (fullOrder) await client.query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) SELECT id, status, 'REFUNDED', $2, 'Refund approved' FROM orders WHERE id = $1 AND status <> 'REFUNDED'`, [r.order_id, req.user?.id ?? null]).catch(() => {})
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
      throw e
    } finally { client.release() }
    const { rows } = await query(`${SELECT} WHERE r.id = $1`, [req.params.id])
    return { success: true, data: toView(rows[0]) }
  })

  // Admin starts a return/refund on the customer's behalf (e.g. after a phone call or chat)
  fastify.post('/', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['orderId', 'scope', 'reason'], properties: {
      orderId: { type: 'string', format: 'uuid' }, scope: { enum: ['FULL_ORDER', 'ITEMS'] }, reason: { type: 'string', minLength: 3, maxLength: 500 },
      orderItemIds: { type: 'array', items: { type: 'string', format: 'uuid' } }, destination: { enum: ['WALLET', 'RAZORPAY'] } }, additionalProperties: false } },
  }, async (req, reply) => {
    const { orderId, scope, reason, orderItemIds = [], destination = 'WALLET' } = req.body
    const o = (await query(`SELECT id, customer_id, total_payable, payment_status FROM orders WHERE id = $1`, [orderId])).rows[0]
    if (!o) return reply.code(404).send({ success: false, message: 'Order not found' })
    const open = await query(`SELECT 1 FROM refund_requests WHERE order_id = $1 AND status IN ('PENDING','PROCESSING','APPROVED') LIMIT 1`, [orderId])
    if (open.rows[0]) return reply.code(409).send({ success: false, message: 'This order already has an active return or refund' })
    let amount = Number(o.total_payable); let items = null
    if (scope === 'ITEMS') {
      if (!orderItemIds.length) return reply.code(400).send({ success: false, message: 'Choose at least one item' })
      const rows = (await query(`SELECT id, product_id, product_name, quantity, subtotal FROM order_items WHERE order_id = $1 AND id = ANY($2::uuid[])`, [orderId, orderItemIds])).rows
      if (!rows.length) return reply.code(400).send({ success: false, message: 'Those items are not part of this order' })
      amount = rows.reduce((t, x) => t + Number(x.subtotal), 0)
      items = rows.map((x) => ({ orderItemId: x.id, productId: x.product_id, name: x.product_name, quantity: Number(x.quantity), total: Number(x.subtotal) }))
    }
    const { rows } = await query(
      `INSERT INTO refund_requests (order_id, customer_id, scope, items, reason, status, refund_destination, computed_amount, source, requested_by)
       VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,'ADMIN',$8) RETURNING id`,
      [orderId, o.customer_id, scope, items ? JSON.stringify(items) : null, reason.trim(), destination, amount, req.user?.id ?? null])
    const r = (await query(`${SELECT} WHERE r.id = $1`, [rows[0].id])).rows[0]
    return reply.code(201).send({ success: true, data: toView(r) })
  })

  fastify.post('/:id/reject', { preHandler: pre }, async (req, reply) => {
    const { rows: cur } = await query(`SELECT status FROM refund_requests WHERE id = $1`, [req.params.id])
    if (!cur[0]) return reply.code(404).send({ success: false, message: 'Refund request not found' })
    if (!['PENDING', 'PROCESSING'].includes(cur[0].status)) {
      return reply.code(409).send({ success: false, message: `Request already ${cur[0].status.toLowerCase()}` })
    }
    await query(
      `UPDATE refund_requests SET status = 'REJECTED', admin_notes = $2, resolved_by = $3, resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id, req.body?.adminNote ?? null, req.user?.id ?? null])
    const client = await getClient()
    try {
      await refundCaseService.recordDecision(client, req.params.id, { approved: false, note: req.body?.adminNote, actorId: req.user?.id ?? null })
    } finally { client.release() }
    const { rows } = await query(`${SELECT} WHERE r.id = $1`, [req.params.id])
    return { success: true, data: toView(rows[0]) }
  })
}
