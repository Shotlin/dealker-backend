import { query } from '../../config/database.js'

const SELECT = `
  SELECT
    rr.*,
    o.order_number,
    o.total_payable AS order_total_payable,
    o.status AS order_status,
    o.payment_status AS order_payment_status,
    o.payment_method AS order_payment_method,
    s.name AS shop_name,
    u.name AS customer_name,
    u.phone AS customer_phone
  FROM refund_requests rr
  JOIN orders o ON o.id = rr.order_id
  JOIN users u ON u.id = rr.customer_id
  LEFT JOIN shops s ON s.id = rr.shop_id
`

export class RefundRequestsRepository {
  async findAll({ status, shopId, customerId, orderId, page = 1, limit = 20 }) {
    const conditions = []
    const params = []
    let idx = 1
    if (status) { conditions.push(`rr.status = $${idx++}`); params.push(status) }
    if (shopId) { conditions.push(`rr.shop_id = $${idx++}`); params.push(shopId) }
    if (customerId) { conditions.push(`rr.customer_id = $${idx++}`); params.push(customerId) }
    if (orderId) { conditions.push(`rr.order_id = $${idx++}`); params.push(orderId) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const offset = (page - 1) * limit

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(`${SELECT} ${where} ORDER BY rr.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, limit, offset]),
      query(`SELECT COUNT(*) AS total FROM refund_requests rr ${where}`, params),
    ])
    return { rows, total: Number(countRows[0].total) }
  }

  async findById(id) {
    const { rows: [row] } = await query(`${SELECT} WHERE rr.id = $1`, [id])
    return row || null
  }

  /** Latest request on an order — the one the customer's order screen shows. */
  async findLatestByOrder(orderId, customerId = null) {
    const params = [orderId]
    let extra = ''
    if (customerId) { params.push(customerId); extra = 'AND rr.customer_id = $2' }
    const { rows: [row] } = await query(
      `${SELECT} WHERE rr.order_id = $1 ${extra} ORDER BY rr.created_at DESC LIMIT 1`,
      params
    )
    return row || null
  }

  async hasBlockingRequest(orderId) {
    // Mobile policy: only a CANCELLED request frees an order up again.
    const { rows } = await query(
      `SELECT id, status FROM refund_requests
        WHERE order_id = $1 AND status <> 'CANCELLED' LIMIT 1`,
      [orderId]
    )
    return rows[0] || null
  }

  async findOrderForRefund(orderId) {
    const { rows: [order] } = await query(
      `SELECT id, order_number, customer_id, shop_id, status, payment_status,
              payment_method, total_payable
         FROM orders WHERE id = $1`,
      [orderId]
    )
    return order || null
  }

  async findOrderItems(orderId) {
    const { rows } = await query(
      `SELECT id, product_id, product_name, quantity, unit_price, subtotal, product_snapshot
         FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId]
    )
    return rows
  }

  async findPaymentForOrder(orderId) {
    const { rows: [p] } = await query(
      `SELECT id, status, amount, razorpay_payment_id
         FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    )
    return p || null
  }

  async create(d) {
    const { rows: [row] } = await query(
      `INSERT INTO refund_requests (
         order_id, customer_id, shop_id, scope, items, reason, refund_destination,
         computed_amount, admin_notes, requested_by, source, reason_code, evidence
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       RETURNING *`,
      [
        d.orderId, d.customerId, d.shopId || null, d.scope,
        d.items ? JSON.stringify(d.items) : null, d.reason, d.refundDestination,
        d.computedAmount, d.adminNotes || null, d.requestedBy, d.source,
        d.reasonCode || null, JSON.stringify(d.evidence || []),
      ]
    )
    return row
  }

  /** Atomic claim — only one concurrent approve can win. */
  async claimForProcessing(id, destination) {
    const { rows: [row] } = await query(
      `UPDATE refund_requests
          SET status = 'PROCESSING',
              refund_destination = COALESCE($2, refund_destination),
              last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'PENDING'
        RETURNING *`,
      [id, destination || null]
    )
    return row || null
  }

  async releaseClaim(id, error) {
    await query(
      `UPDATE refund_requests
          SET status = 'PENDING', last_error = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'PROCESSING'`,
      [id, String(error || '').slice(0, 500)]
    )
  }

  async finalize(id, { status, resolvedAmount, resolvedBy, adminNotes, refundReference }) {
    const { rows: [row] } = await query(
      `UPDATE refund_requests
          SET status = $2::varchar, resolved_amount = $3, resolved_by = $4, resolved_at = NOW(),
              admin_notes = COALESCE($5, admin_notes),
              refund_reference = COALESCE($6, refund_reference),
              refunded_at = CASE WHEN $2::varchar = 'APPROVED' THEN NOW() ELSE refunded_at END,
              last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND status IN ('PENDING','PROCESSING')
        RETURNING *`,
      [id, status, resolvedAmount, resolvedBy, adminNotes ?? null, refundReference ?? null]
    )
    return row || null
  }

  async cancelByCustomer(id, customerId) {
    const { rows: [row] } = await query(
      `UPDATE refund_requests
          SET status = 'CANCELLED', resolved_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND customer_id = $2 AND status = 'PENDING'
        RETURNING *`,
      [id, customerId]
    )
    return row || null
  }

  /**
   * An admin refunded the whole order directly ("Process Refund" in the order
   * drawer) while a customer request was still open — close it out so the
   * customer's app and the Returns queue don't keep showing it as pending.
   */
  async resolvePendingForOrder(orderId, { amount, resolvedBy, destination, note }) {
    const { rows } = await query(
      `UPDATE refund_requests
          SET status = 'APPROVED', resolved_amount = $2, resolved_by = $3, resolved_at = NOW(),
              refunded_at = NOW(), refund_destination = $4,
              admin_notes = COALESCE(admin_notes, $5), updated_at = NOW()
        WHERE order_id = $1 AND status IN ('PENDING','PROCESSING')
        RETURNING id`,
      [orderId, amount, resolvedBy, destination, note]
    )
    return rows.map((r) => r.id)
  }
}
