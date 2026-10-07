import { query, getClient } from '../../../config/database.js'
import { OPEN_ASSIGNMENT_STATUSES, sqlInList } from '../../../constants/delivery-statuses.js'

export class AdminOrdersRepository {
  /**
   * Shared WHERE-clause builder for `findAll` and `getSettlementSummary` —
   * both need to answer "for exactly this filtered view" (same shop scope,
   * date range, status, etc.), and per the same discipline `findAll`'s own
   * count query already follows ("pagination totals are never computed
   * against a different filter set than what's displayed"), a settlement
   * total computed against a drifted copy of these filters would be a
   * silent, hard-to-notice correctness bug — the exact category of bug
   * this codebase has repeatedly hit elsewhere. `alias` lets the caller
   * pick the FROM-table alias (`o`) since both queries use the same one.
   */
  _buildOrderFilters({
    status, paymentMethod, paymentStatus, search, startDate, endDate,
    deliveryType, shopId, riderId, minAmount, maxAmount, needsPaymentReview, recoveredFromFailed,
  }) {
    const params = []
    let idx = 1
    let clause = ''

    // Shop scope — `shopId` is `request.shopId` as resolved by the shared
    // `requireShopScope` middleware (shop-staff JWT, else HQ's optional
    // X-Shop-Id header). `null` means "All Shops" for an HQ user; a
    // shop-scoped staff JWT always carries a concrete value, so this branch
    // is the ONLY thing that actually enforces per-branch order history —
    // previously the dashboard's shop selector filtered nothing server-side.
    if (shopId) { params.push(shopId); clause += ` AND o.shop_id = $${idx++}` }
    if (status) { params.push(status); clause += ` AND o.status = $${idx++}` }
    if (paymentMethod) { params.push(paymentMethod); clause += ` AND o.payment_method = $${idx++}` }
    if (paymentStatus) { params.push(paymentStatus); clause += ` AND o.payment_status = $${idx++}` }
    if (riderId) { params.push(riderId); clause += ` AND o.rider_id = $${idx++}` }
    if (minAmount !== undefined && minAmount !== null) { params.push(minAmount); clause += ` AND o.total_payable >= $${idx++}` }
    if (maxAmount !== undefined && maxAmount !== null) { params.push(maxAmount); clause += ` AND o.total_payable <= $${idx++}` }
    if (needsPaymentReview) { clause += ` AND p.needs_manual_review = true` }
    if (recoveredFromFailed) { clause += ` AND p.recovered_from_failed = true` }
    if (startDate) { params.push(startDate); clause += ` AND o.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); clause += ` AND o.created_at <= $${idx++}` }
    if (search) {
      params.push(`%${search}%`)
      clause += ` AND (o.order_number ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.name ILIKE $${idx})`
      idx++
    }
    if (deliveryType === 'express') {
      clause += ` AND o.delivery_mode = 'ASAP' AND o.quick_delivery_selected = true`
    } else if (deliveryType === 'standard') {
      clause += ` AND o.delivery_mode = 'ASAP' AND o.quick_delivery_selected = false`
    } else if (deliveryType === 'scheduled') {
      clause += ` AND o.delivery_mode = 'SCHEDULED'`
    }

    return { clause, params, nextIdx: idx }
  }

  async findAll({ offset, limit, ...filters }) {
    // LEFT JOIN payments on the most recent row per order — needed for the
    // paymentStatus/needsPaymentReview/recoveredFromFailed filters, which
    // live on `payments`, not `orders`. A LATERAL join picks exactly one
    // (the latest) payment row per order rather than fanning an order out
    // across every payment attempt it ever had.
    const { clause, params, nextIdx } = this._buildOrderFilters(filters)
    let idx = nextIdx

    let sql = `
      SELECT o.*, u.name AS customer_name, u.phone AS customer_phone,
             ru.name AS rider_name, sh.name AS shop_name,
             (SELECT string_agg(DISTINCT v.name, ', ') FROM seller_orders so JOIN vendors v ON v.id = so.vendor_id WHERE so.order_id = o.id) AS seller_names,
             p.status AS payment_gateway_status,
             p.needs_manual_review AS payment_needs_manual_review,
             p.recovered_from_failed AS payment_recovered_from_failed,
             CASE
               WHEN o.delivery_mode = 'SCHEDULED' THEN 'SCHEDULED'
               WHEN o.quick_delivery_selected = true THEN 'EXPRESS'
               ELSE 'STANDARD'
             END AS order_type
      FROM orders o
      LEFT JOIN users u ON u.id = o.customer_id
      LEFT JOIN users ru ON ru.id = o.rider_id
      LEFT JOIN shops sh ON sh.id = o.shop_id
      LEFT JOIN LATERAL (
        SELECT status, needs_manual_review, recovered_from_failed
        FROM payments
        WHERE payments.order_id = o.id
        ORDER BY created_at DESC
        LIMIT 1
      ) p ON true
      WHERE 1=1 ${clause}
    `

    // Count query mirrors the exact same WHERE clause and params as the
    // list query (same JOINs too — the payment-based filters need them)
    // so pagination totals are never computed against a different filter
    // set than what's actually displayed.
    const countSql = `
      SELECT COUNT(*) FROM orders o
      LEFT JOIN users u ON u.id = o.customer_id
      LEFT JOIN LATERAL (
        SELECT status, needs_manual_review, recovered_from_failed
        FROM payments
        WHERE payments.order_id = o.id
        ORDER BY created_at DESC
        LIMIT 1
      ) p ON true
      WHERE 1=1 ${clause}
    `
    const countRes = await query(countSql, params)
    const total = parseInt(countRes.rows[0].count)

    params.push(limit, offset)
    sql += ` ORDER BY o.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`

    const { rows } = await query(sql, params)
    return { orders: rows, total }
  }

  /**
   * Customer-money-settled summary for the exact same filtered view
   * `findAll` shows (same shop scope, date range, status, etc. — via the
   * shared `_buildOrderFilters`) — how much has genuinely been collected
   * via Cash on Delivery vs. online (Razorpay), how much of that was
   * covered by wallet balance rather than new money, and how much is
   * still outstanding. `payment_status = 'PAID'` is the only thing that
   * means money actually changed hands; a COD order sitting at `PENDING`
   * has collected nothing yet, no matter how old it is.
   */
  async getSettlementSummary(filters) {
    const { clause, params } = this._buildOrderFilters(filters)
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN o.payment_status = 'PAID' AND o.payment_method = 'COD' THEN o.total_payable - o.wallet_amount ELSE 0 END), 0) AS cod_collected,
         COALESCE(SUM(CASE WHEN o.payment_status = 'PAID' AND o.payment_method != 'COD' THEN o.total_payable - o.wallet_amount ELSE 0 END), 0) AS online_collected,
         COALESCE(SUM(CASE WHEN o.wallet_amount > 0 THEN o.wallet_amount ELSE 0 END), 0) AS wallet_collected,
         COALESCE(SUM(CASE WHEN o.payment_status != 'PAID' THEN o.total_payable - o.wallet_amount ELSE 0 END), 0) AS pending_amount,
         COUNT(*)::int AS order_count
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN LATERAL (
         SELECT status, needs_manual_review, recovered_from_failed
         FROM payments
         WHERE payments.order_id = o.id
         ORDER BY created_at DESC
         LIMIT 1
       ) p ON true
       WHERE 1=1 ${clause}`,
      params
    )
    const row = rows[0]
    return {
      codCollected: Number(row.cod_collected),
      onlineCollected: Number(row.online_collected),
      walletCollected: Number(row.wallet_collected),
      pendingAmount: Number(row.pending_amount),
      orderCount: row.order_count,
    }
  }

  async getStatsByStatus() {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`
    )
    const stats = rows.reduce((acc, r) => { acc[r.status] = r.count; return acc }, {})

    const [{ rows: reviewRows }, { rows: recoveredRows }] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count FROM payments WHERE needs_manual_review = true`),
      query(`SELECT COUNT(*)::int AS count FROM payments WHERE recovered_from_failed = true`),
    ])
    stats.NEEDS_REVIEW = reviewRows[0].count
    stats.RECOVERED = recoveredRows[0].count

    return stats
  }

  async findById(orderId) {
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
              ru.name AS rider_name, ru.phone AS rider_phone,
              CASE
                WHEN o.delivery_mode = 'SCHEDULED' THEN 'SCHEDULED'
                WHEN o.quick_delivery_selected = true THEN 'EXPRESS'
                ELSE 'STANDARD'
              END AS order_type
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.id = $1`,
      [orderId]
    )
    return rows[0] || null
  }

  async getOrderItems(orderId) {
    const { rows } = await query(
      `SELECT oi.*, p.thumbnail_url, p.net_quantity
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at`,
      [orderId]
    )
    return rows
  }

  async getOrderTimeline(orderId) {
    const { rows } = await query(
      `SELECT osh.*, u.name AS changed_by_name
       FROM order_status_history osh
       LEFT JOIN users u ON u.id = osh.changed_by
       WHERE osh.order_id = $1
       ORDER BY osh.changed_at ASC`,
      [orderId]
    )
    return rows
  }

  async getOrderNotes(orderId) {
    const { rows } = await query(
      `SELECT n.*, u.name AS author_name
       FROM order_notes n
       LEFT JOIN users u ON u.id = n.author_id
       WHERE n.order_id = $1
       ORDER BY n.created_at ASC`,
      [orderId]
    )
    return rows
  }

  async addOrderNote(orderId, authorId, body) {
    const { rows } = await query(
      `WITH ins AS (
         INSERT INTO order_notes (order_id, author_id, body)
         VALUES ($1, $2, $3)
         RETURNING *
       )
       SELECT ins.*, u.name AS author_name
       FROM ins
       LEFT JOIN users u ON u.id = ins.author_id`,
      [orderId, authorId, body]
    )
    return rows[0]
  }

  async getOrderPayment(orderId) {
    const { rows } = await query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )
    return rows[0] || null
  }

  async getOrderDelivery(orderId) {
    const { rows } = await query(
      'SELECT * FROM delivery_assignments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )
    return rows[0] || null
  }

  /**
   * The order's own row, locked, for the settlement transaction — needs to
   * be read-then-written atomically with the settlement history so two
   * concurrent "Record Payment" submissions can never both believe the
   * full outstanding balance is still available.
   */
  async findByIdForUpdate(client, orderId) {
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
    return rows[0] || null
  }

  async getSettlementHistory(orderId, client = null) {
    const runner = client || { query: (text, params) => query(text, params) }
    const { rows } = await runner.query(
      `SELECT s.*, u.name AS recorded_by_name
       FROM order_payment_settlements s
       LEFT JOIN users u ON u.id = s.recorded_by
       WHERE s.order_id = $1
       ORDER BY s.created_at ASC`,
      [orderId]
    )
    return rows
  }

  async insertSettlementEntry(client, data) {
    const { rows } = await client.query(
      `INSERT INTO order_payment_settlements (
        order_id, entry_type, amount, method, cash_amount, upi_amount,
        reference, method_note, internal_note, reverses_entry_id, recorded_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        data.orderId, data.entryType, data.amount, data.method,
        data.cashAmount || 0, data.upiAmount || 0, data.reference || null,
        data.methodNote || null, data.internalNote || null,
        data.reversesEntryId || null, data.recordedBy,
      ]
    )
    return rows[0]
  }

  async setPaymentStatus(client, orderId, paymentStatus) {
    await client.query(
      `UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2`,
      [paymentStatus, orderId]
    )
  }

  async updateStatus(orderId, newStatus, adminId, note) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query(
        'SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]
      )
      if (!order) throw { statusCode: 404, message: 'Order not found' }

      // Only the rider-app delivery-completion flow (delivery.repository.js)
      // was setting delivered_at — this admin-dashboard path never did, so
      // any order an admin marked DELIVERED directly (support/testing) had
      // a permanently NULL delivered_at. The nightly settlement worker
      // filters strictly on delivered_at falling within its date window,
      // so those orders were silently excluded from shop_financials and
      // shop_transactions forever, even though status correctly read
      // DELIVERED everywhere else in the dashboard.
      if (newStatus === 'DELIVERED') {
        await client.query(
          `UPDATE orders SET status = $1, delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW() WHERE id = $2`,
          [newStatus, orderId]
        )
      } else {
        await client.query(
          'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
          [newStatus, orderId]
        )
      }

      // Keep the rider-facing assignment in lock-step with a terminal
      // dashboard action.  Previously the dashboard only updated `orders`.
      // The rider's GET /delivery/orders query is intentionally keyed by
      // `delivery_assignments.status`, so an admin-delivered/cancelled order
      // could remain in a rider's active batch after any reconnect or refresh.
      // Updating both records in this transaction makes the socket event and
      // the subsequent REST reconciliation describe the same truth.
      if (newStatus === 'DELIVERED' || newStatus === 'CANCELLED') {
        const assignmentTimestampColumn = newStatus === 'DELIVERED'
          ? 'delivered_at'
          : 'cancelled_at'
        await client.query(
          `UPDATE delivery_assignments
           SET status = $1,
               ${assignmentTimestampColumn} = COALESCE(${assignmentTimestampColumn}, NOW()),
               updated_at = NOW()
           WHERE order_id = $2
             AND status = ANY($3::text[])`,
          [newStatus, orderId, OPEN_ASSIGNMENT_STATUSES]
        )
      }

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, order.status, newStatus, adminId, note || null]
      )

      await client.query('COMMIT')
      return order.status // return old status for activity log
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** Plain field update — no status-machine transition involved, unlike updateStatus(). */
  async rescheduleDelivery(orderId, { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel }) {
    const { rows } = await query(
      `UPDATE orders
       SET delivery_mode = 'SCHEDULED',
           scheduled_delivery_at = $1,
           scheduled_slot_start = $1,
           scheduled_slot_end = $2,
           scheduled_slot_label = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, customer_id, rider_id, order_number, status,
                 scheduled_slot_start, scheduled_slot_end, scheduled_slot_label`,
      [scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, orderId]
    )
    return rows[0] || null
  }

  async assignRider(orderId, riderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `UPDATE delivery_assignments
         SET status = 'CANCELLED',
             cancel_reason = 'Reassigned by admin',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1
           AND status IN (${sqlInList(OPEN_ASSIGNMENT_STATUSES)})`,
        [orderId]
      )

      await client.query(
        'UPDATE orders SET rider_id = $1, updated_at = NOW() WHERE id = $2',
        [riderId, orderId]
      )

      // Create a fresh assignment row (no ON CONFLICT dependency on order_id).
      const { rows: [assignment] } = await client.query(
        `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
         SELECT $1, $2, 'ASSIGNED', NOW(), COALESCE(NULLIF(o.delivery_fee, 0), 25)
         FROM orders o
         WHERE o.id = $1
         RETURNING id, order_id, rider_id, status, assigned_at`,
        [orderId, riderId]
      )

      await client.query('COMMIT')
      return assignment
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async bulkAssign(assignments) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const results = []
      for (const { orderId, riderId } of assignments) {
        await client.query(
          `UPDATE delivery_assignments
           SET status = 'CANCELLED',
               cancel_reason = 'Reassigned by bulk assign',
               cancelled_at = NOW(),
               updated_at = NOW()
           WHERE order_id = $1
             AND status IN (${sqlInList(OPEN_ASSIGNMENT_STATUSES)})`,
          [orderId]
        )

        await client.query(
          'UPDATE orders SET rider_id = $1, updated_at = NOW() WHERE id = $2',
          [riderId, orderId]
        )

        const { rows: [assignment] } = await client.query(
          `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
           SELECT $1, $2, 'ASSIGNED', NOW(), COALESCE(NULLIF(o.delivery_fee, 0), 25)
           FROM orders o
           WHERE o.id = $1
           RETURNING id, order_id, rider_id, status, assigned_at`,
          [orderId, riderId]
        )
        results.push({
          assignmentId: assignment.id,
          orderId,
          riderId,
          status: 'assigned',
        })
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async createManualOrder({ userId, items, paymentMethod, deliveryAddress, couponCode, adminId, shopId }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Calculate totals
      let subtotal = 0
      const orderItems = []
      for (const item of items) {
        const { rows: [product] } = await client.query(
          'SELECT id, name, price, sale_price, stock_quantity, unit FROM products WHERE id = $1 AND is_active = true',
          [item.productId]
        )
        if (!product) throw { statusCode: 400, message: `Product ${item.productId} not found` }
        if (product.stock_quantity < item.quantity) throw { statusCode: 400, message: `${product.name} out of stock` }

        const price = product.sale_price || product.price
        const total = price * item.quantity
        subtotal += total
        orderItems.push({
          product_id: product.id,
          name: product.name,
          price: parseFloat(price),
          quantity: item.quantity,
          unit: product.unit,
          total: parseFloat(total),
        })
      }

      // Generate order number
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`

      const { rows: [order] } = await client.query(
        `INSERT INTO orders (order_number, customer_id, shop_id, status, items, subtotal, total_payable, payment_method, payment_status, delivery_address)
         VALUES ($1, $2, $9, 'CONFIRMED', $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orderNumber, userId, JSON.stringify(orderItems),
          subtotal, subtotal, paymentMethod || 'MANUAL',
          paymentMethod === 'COD' ? 'PENDING' : 'PAID',
          JSON.stringify(deliveryAddress),
          shopId || null,
        ]
      )

      // Insert order items
      for (const oi of orderItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, unit, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, oi.product_id, oi.name, oi.price, oi.quantity, oi.unit, oi.total]
        )
        // Deduct stock
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2',
          [oi.quantity, oi.product_id]
        )
      }

      // Log initial status
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, NULL, 'CONFIRMED', $2, 'Manual order by admin')`,
        [order.id, adminId]
      )

      await client.query('COMMIT')
      return order
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getOrdersForExport({ status, startDate, endDate }) {
    let sql = `
      SELECT o.order_number, o.status, o.total_payable, o.payment_method, o.payment_status,
             o.created_at, u.name AS customer, u.phone, o.delivery_address->>'city' AS city
      FROM orders o
      LEFT JOIN users u ON u.id = o.customer_id
      WHERE 1=1
    `
    const params = []
    let idx = 1
    if (status) { params.push(status); sql += ` AND o.status = $${idx++}` }
    if (startDate) { params.push(startDate); sql += ` AND o.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); sql += ` AND o.created_at <= $${idx++}` }
    sql += ' ORDER BY o.created_at DESC'

    const { rows } = await query(sql, params)
    return rows
  }

  async findUserByPhone(phone) {
    const { rows } = await query('SELECT id, name, phone FROM users WHERE phone = $1', [phone])
    return rows[0] || null
  }
}
