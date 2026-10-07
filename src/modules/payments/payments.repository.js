import { query } from '../../config/database.js'

/**
 * Payments repository — all SQL queries for payments
 */
export class PaymentsRepository {
  /**
   * Create a payment record
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO payments (order_id, user_id, razorpay_order_id, amount, currency, status, method, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        data.orderId,
        data.userId,
        data.razorpayOrderId || null,
        data.amount,
        data.currency || 'INR',
        data.status || 'PENDING',
        data.method || null,
        data.expiresAt || null,
        JSON.stringify(data.metadata || {}),
      ]
    )
    return this._format(rows[0])
  }

  /**
   * Find payment by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT * FROM payments WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find payment by Razorpay order ID
   */
  async findByRazorpayOrderId(razorpayOrderId) {
    const { rows } = await query(
      `SELECT * FROM payments WHERE razorpay_order_id = $1`,
      [razorpayOrderId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Same lookup, but row-locked inside the caller's transaction. This is
   * the idempotency primitive for `PaymentsService#completeVerifiedPayment`
   * — two racing finalizers (e.g. the client's `/verify` call and the
   * webhook's `payment.captured` event landing at nearly the same moment)
   * serialize on this lock; whichever acquires it second sees the first
   * one's committed `status = 'PAID'` and safely no-ops instead of running
   * the confirmation cascade twice.
   */
  async findByRazorpayOrderIdForUpdate(client, razorpayOrderId) {
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE razorpay_order_id = $1 FOR UPDATE`,
      [razorpayOrderId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find payment by Razorpay payment ID — the only identifier a
   * `refund.processed` webhook payload actually carries (it has no
   * razorpay_order_id).
   */
  async findByRazorpayPaymentId(razorpayPaymentId) {
    const { rows } = await query(
      `SELECT * FROM payments WHERE razorpay_payment_id = $1`,
      [razorpayPaymentId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find payment by order ID
   */
  async findByOrderId(orderId) {
    const { rows } = await query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Update payment after verification. Pass `client` (a transaction client
   * from `getClient()`) to run inside the caller's own transaction — every
   * call from `completeVerifiedPayment` does this, since the row is already
   * locked there via `findByRazorpayOrderIdForUpdate`.
   */
  async updatePayment(id, data, client = null) {
    const runner = client || { query: (text, params) => query(text, params) }
    const sets = ['updated_at = NOW()']
    const params = []
    let idx = 1

    if (data.razorpayPaymentId) {
      sets.push(`razorpay_payment_id = $${idx++}`)
      params.push(data.razorpayPaymentId)
    }
    if (data.razorpaySignature) {
      sets.push(`razorpay_signature = $${idx++}`)
      params.push(data.razorpaySignature)
    }
    if (data.status) {
      sets.push(`status = $${idx++}`)
      params.push(data.status)
    }
    if (data.method) {
      sets.push(`method = $${idx++}`)
      params.push(data.method)
    }
    if (data.metadata) {
      sets.push(`metadata = $${idx++}`)
      params.push(JSON.stringify(data.metadata))
    }
    if (data.needsManualReview !== undefined) {
      sets.push(`needs_manual_review = $${idx++}`)
      params.push(!!data.needsManualReview)
    }
    if (data.recoveredFromFailed !== undefined) {
      sets.push(`recovered_from_failed = $${idx++}`)
      params.push(!!data.recoveredFromFailed)
    }
    if (data.reviewReason !== undefined) {
      sets.push(`review_reason = $${idx++}`)
      params.push(data.reviewReason)
    }
    if (data.errorCode !== undefined) {
      sets.push(`error_code = $${idx++}`)
      params.push(data.errorCode)
    }
    if (data.errorDescription !== undefined) {
      sets.push(`error_description = $${idx++}`)
      params.push(data.errorDescription)
    }
    if (data.errorSource !== undefined) {
      sets.push(`error_source = $${idx++}`)
      params.push(data.errorSource)
    }
    if (data.errorStep !== undefined) {
      sets.push(`error_step = $${idx++}`)
      params.push(data.errorStep)
    }
    if (data.errorReason !== undefined) {
      sets.push(`error_reason = $${idx++}`)
      params.push(data.errorReason)
    }

    params.push(id)

    const { rows } = await runner.query(
      `UPDATE payments SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Record webhook event in payment_webhook_events table
   * Spec §5.4.2, §7.10.2, §11.15.5
   */
  async recordWebhookEvent({ provider = 'RAZORPAY', providerEventId, eventType, payloadHash, signatureValid = true, processingStatus = 'COMPLETED', lastError = null }) {
    const { rows } = await query(
      `INSERT INTO payment_webhook_events (provider, provider_event_id, event_type, payload_hash, signature_valid, processing_status, last_error, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING *`,
      [provider, providerEventId, eventType, payloadHash, signatureValid, processingStatus, lastError]
    )
    return rows[0] ? rows[0] : null
  }

  /**
   * Update refund fields
   */
  async updateRefund(id, refundData) {
    const { rows } = await query(
      `UPDATE payments SET
        refund_id = $1,
        refund_amount = $2,
        refund_status = $3,
        status = 'REFUNDED',
        updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [refundData.refundId, refundData.refundAmount, refundData.refundStatus || 'PROCESSED', id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Get payment history for a user (paginated)
   */
  async findByUser(userId, { limit, offset }) {
    const countResult = await query(
      `SELECT COUNT(*) FROM payments WHERE user_id = $1`,
      [userId]
    )

    const { rows } = await query(
      `SELECT * FROM payments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )

    return {
      payments: rows.map(this._format),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Format snake_case row to camelCase
   */
  _format(row) {
    return {
      id: row.id,
      orderId: row.order_id,
      userId: row.user_id,
      razorpayOrderId: row.razorpay_order_id,
      razorpayPaymentId: row.razorpay_payment_id,
      razorpaySignature: row.razorpay_signature,
      amount: parseFloat(row.amount),
      currency: row.currency,
      status: row.status,
      method: row.method,
      expiresAt: row.expires_at || null,
      refundId: row.refund_id,
      refundAmount: row.refund_amount ? parseFloat(row.refund_amount) : null,
      refundStatus: row.refund_status,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      needsManualReview: !!row.needs_manual_review,
      recoveredFromFailed: !!row.recovered_from_failed,
      reviewReason: row.review_reason || null,
      errorCode: row.error_code || null,
      errorDescription: row.error_description || null,
      errorSource: row.error_source || null,
      errorStep: row.error_step || null,
      errorReason: row.error_reason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
