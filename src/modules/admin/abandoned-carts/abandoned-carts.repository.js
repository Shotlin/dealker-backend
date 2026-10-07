import { query } from '../../../config/database.js'

/**
 * Admin-facing READ repository for the Abandoned Cart Management System —
 * mirrors the existing notifications vs admin/notifications split. The
 * write path (detection, recovery, conversion) lives in the core module
 * at src/modules/abandoned-carts/abandoned-carts.repository.js; this one
 * only ever SELECTs, plus the two admin actions (notify/coupon) that
 * record a link row against an already-existing episode.
 */
export class AdminAbandonedCartsRepository {
  async findAll({ offset, limit, search, status = 'OPEN', minValue, maxValue, sortBy = 'abandoned_at', sortOrder = 'DESC' }) {
    const params = []
    const clauses = []
    let idx = 1

    if (status && status !== 'ALL') {
      clauses.push(`ac.status = $${idx}`)
      params.push(status)
      idx++
    }
    if (search) {
      clauses.push(`(u.name ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.email ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    if (minValue !== undefined && minValue !== null) {
      clauses.push(`ac.cart_value >= $${idx}`)
      params.push(minValue)
      idx++
    }
    if (maxValue !== undefined && maxValue !== null) {
      clauses.push(`ac.cart_value <= $${idx}`)
      params.push(maxValue)
      idx++
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

    const allowedSort = {
      priority_score: 'ac.priority_score',
      cart_value: 'ac.cart_value',
      abandoned_at: 'ac.abandoned_at',
      item_count: 'ac.item_count',
    }
    const orderCol = allowedSort[sortBy] || 'ac.priority_score'
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC'

    const { rows } = await query(
      `SELECT ac.id, ac.user_id, ac.status, ac.abandoned_at, ac.item_count, ac.total_quantity,
              ac.cart_value, ac.priority_score, ac.reminder_count, ac.last_reminder_sent_at,
              ac.recovered_at, ac.converted_at,
              u.name AS user_name, u.phone AS user_phone, u.email AS user_email
       FROM abandoned_carts ac
       JOIN users u ON u.id = ac.user_id
       ${where}
       ORDER BY ${orderCol} ${dir} NULLS LAST
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM abandoned_carts ac JOIN users u ON u.id = ac.user_id ${where}`,
      params
    )
    const total = countRows[0].total

    return {
      carts: rows.map(this._formatListRow),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async findById(id) {
    const { rows: [episode] } = await query(
      `SELECT ac.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
              u.wallet_balance, u.loyalty_points
       FROM abandoned_carts ac
       JOIN users u ON u.id = ac.user_id
       WHERE ac.id = $1`,
      [id]
    )
    if (!episode) return null

    const [{ rows: items }, { rows: events }, { rows: notifications }, { rows: coupons }, history, customer] = await Promise.all([
      query(
        `SELECT ci.product_id, ci.shop_id, s.name AS shop_name, ci.product_name,
                ci.product_thumbnail_url, ci.product_unit,
                ci.quantity, ci.unit_price, ci.list_price, ci.line_total
         FROM abandoned_cart_items ci
         LEFT JOIN shops s ON s.id = ci.shop_id
         WHERE ci.abandoned_cart_id = $1 ORDER BY ci.created_at`,
        [id]
      ),
      query(
        `SELECT event_type, actor_type, actor_id, metadata, created_at
         FROM abandoned_cart_events WHERE abandoned_cart_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      query(
        `SELECT acn.id, acn.notification_id, acn.template_id, acn.sent_by, acn.created_at,
                n.title, n.body
         FROM abandoned_cart_notifications acn
         LEFT JOIN notifications n ON n.id = acn.notification_id
         WHERE acn.abandoned_cart_id = $1 ORDER BY acn.created_at DESC`,
        [id]
      ),
      query(
        `SELECT acc.id, acc.coupon_id, acc.issued_by, acc.created_at, c.code, c.discount_type, c.discount_value
         FROM abandoned_cart_coupons acc
         LEFT JOIN coupons c ON c.id = acc.coupon_id
         WHERE acc.abandoned_cart_id = $1 ORDER BY acc.created_at DESC`,
        [id]
      ),
      this._getHistory(episode.user_id, id),
      this._getCustomerStats(episode.user_id),
    ])

    return this._formatDetail(episode, items, events, notifications, coupons, history, customer)
  }

  /** The customer's OTHER abandonment episodes — shows whether this is a habit. */
  async _getHistory(userId, excludeId) {
    const [{ rows: [agg] }, { rows: previous }] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'RECOVERED')::int AS recovered,
                COUNT(*) FILTER (WHERE status = 'CONVERTED')::int AS converted,
                COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
                COALESCE(SUM(cart_value), 0) AS total_value,
                COALESCE(SUM(reminder_count), 0)::int AS reminders
         FROM abandoned_carts WHERE user_id = $1 AND id <> $2`,
        [userId, excludeId]
      ),
      query(
        `SELECT id, status, abandoned_at, cart_value, item_count, reminder_count
         FROM abandoned_carts WHERE user_id = $1 AND id <> $2
         ORDER BY abandoned_at DESC LIMIT 5`,
        [userId, excludeId]
      ),
    ])
    return {
      totalEpisodes: agg.total,
      recoveredCount: agg.recovered,
      convertedCount: agg.converted,
      expiredCount: agg.expired,
      totalAbandonedValue: parseFloat(agg.total_value),
      remindersSent: agg.reminders,
      previous: previous.map((r) => ({
        id: r.id,
        status: r.status,
        abandonedAt: r.abandoned_at,
        cartValue: parseFloat(r.cart_value),
        itemCount: r.item_count,
        reminderCount: r.reminder_count,
      })),
    }
  }

  async _getCustomerStats(userId) {
    const { rows: [row] } = await query(
      `SELECT COUNT(*)::int AS order_count,
              COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered_count,
              COALESCE(SUM(total_payable) FILTER (WHERE status = 'DELIVERED'), 0) AS ltv,
              MAX(created_at) AS last_order_at
       FROM orders WHERE customer_id = $1`,
      [userId]
    )
    return {
      orderCount: row.order_count,
      deliveredCount: row.delivered_count,
      lifetimeValue: parseFloat(row.ltv),
      lastOrderAt: row.last_order_at,
    }
  }

  async getSummary() {
    const { rows: [openStats] } = await query(
      `SELECT COUNT(*)::int AS open_count, COALESCE(SUM(cart_value), 0) AS open_value,
              COALESCE(AVG(cart_value), 0) AS avg_cart_value
       FROM abandoned_carts WHERE status = 'OPEN'`
    )
    const { rows: [todayStats] } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'RECOVERED' AND recovered_at::date = CURRENT_DATE)::int AS recovered_today,
         COALESCE(SUM(cart_value) FILTER (WHERE status = 'RECOVERED' AND recovered_at::date = CURRENT_DATE), 0) AS recovered_value_today,
         COUNT(*) FILTER (WHERE status = 'CONVERTED' AND converted_at::date = CURRENT_DATE)::int AS converted_today,
         COALESCE(SUM(cart_value) FILTER (WHERE status = 'CONVERTED' AND converted_at::date = CURRENT_DATE), 0) AS converted_value_today
       FROM abandoned_carts`
    )
    const { rows: [weekStats] } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('RECOVERED', 'CONVERTED'))::int AS recovered_or_converted,
         COUNT(*) FILTER (WHERE status != 'OPEN')::int AS closed
       FROM abandoned_carts WHERE created_at >= NOW() - INTERVAL '7 days'`
    )

    const { rows: [extra] } = await query(
      `SELECT COALESCE(SUM(cart_value) FILTER (WHERE status IN ('RECOVERED','CONVERTED')), 0) AS recovered_value_7d,
              COALESCE(SUM(reminder_count), 0)::int AS reminders_7d
       FROM abandoned_carts WHERE created_at >= NOW() - INTERVAL '7 days'`
    )

    const closed = weekStats.closed || 0
    const recoveryRate7d = closed > 0 ? weekStats.recovered_or_converted / closed : 0

    return {
      openCount: openStats.open_count,
      openValue: parseFloat(openStats.open_value),
      avgCartValue: parseFloat(openStats.avg_cart_value),
      recoveredToday: todayStats.recovered_today,
      recoveredValueToday: parseFloat(todayStats.recovered_value_today),
      convertedToday: todayStats.converted_today,
      convertedValueToday: parseFloat(todayStats.converted_value_today),
      recoveryRate7d: Math.round(recoveryRate7d * 1000) / 1000,
      recoveredValue7d: parseFloat(extra.recovered_value_7d),
      remindersSent7d: extra.reminders_7d,
    }
  }

  async recordNotification(abandonedCartId, { notificationId, templateId = null, sentBy = null }) {
    await query(
      `INSERT INTO abandoned_cart_notifications (abandoned_cart_id, notification_id, template_id, sent_by)
       VALUES ($1, $2, $3, $4)`,
      [abandonedCartId, notificationId, templateId, sentBy]
    )
    await query(
      `UPDATE abandoned_carts
         SET reminder_count = reminder_count + 1, last_reminder_sent_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [abandonedCartId]
    )
    await query(
      `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id)
       VALUES ($1, 'REMINDER_SENT', 'ADMIN', $2)`,
      [abandonedCartId, sentBy]
    )
  }

  async recordCoupon(abandonedCartId, { couponId, issuedBy = null }) {
    await query(
      `INSERT INTO abandoned_cart_coupons (abandoned_cart_id, coupon_id, issued_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (abandoned_cart_id, coupon_id) DO NOTHING`,
      [abandonedCartId, couponId, issuedBy]
    )
    await query(
      `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id, metadata)
       VALUES ($1, 'COUPON_ISSUED', 'ADMIN', $2, $3)`,
      [abandonedCartId, issuedBy, JSON.stringify({ couponId })]
    )
  }

  _formatListRow(row) {
    return {
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      userPhone: row.user_phone,
      userEmail: row.user_email,
      status: row.status,
      abandonedAt: row.abandoned_at,
      itemCount: row.item_count,
      totalQuantity: row.total_quantity,
      cartValue: parseFloat(row.cart_value),
      priorityScore: parseFloat(row.priority_score),
      reminderCount: row.reminder_count,
      lastReminderSentAt: row.last_reminder_sent_at,
      recoveredAt: row.recovered_at,
      convertedAt: row.converted_at,
    }
  }

  _formatDetail(episode, items, events, notifications, coupons, history, customer) {
    return {
      id: episode.id,
      status: episode.status,
      abandonedAt: episode.abandoned_at,
      detectedAt: episode.detected_at,
      itemCount: episode.item_count,
      totalQuantity: episode.total_quantity,
      cartValue: parseFloat(episode.cart_value),
      priorityScore: parseFloat(episode.priority_score),
      priorityBreakdown: episode.priority_breakdown,
      recoveredAt: episode.recovered_at,
      convertedAt: episode.converted_at,
      convertedOrderId: episode.converted_order_id,
      expiredAt: episode.expired_at,
      reminderCount: episode.reminder_count,
      lastReminderSentAt: episode.last_reminder_sent_at,
      user: {
        id: episode.user_id,
        name: episode.user_name,
        phone: episode.user_phone,
        email: episode.user_email,
        walletBalance: parseFloat(episode.wallet_balance || 0),
        loyaltyPoints: episode.loyalty_points,
        orderCount: customer.orderCount,
        deliveredCount: customer.deliveredCount,
        lifetimeValue: customer.lifetimeValue,
        lastOrderAt: customer.lastOrderAt,
      },
      history,
      items: items.map((i) => ({
        productId: i.product_id,
        shopId: i.shop_id,
        shopName: i.shop_name ?? null,
        productName: i.product_name,
        thumbnailUrl: i.product_thumbnail_url,
        unit: i.product_unit,
        quantity: i.quantity,
        unitPrice: parseFloat(i.unit_price),
        listPrice: parseFloat(i.list_price),
        lineTotal: parseFloat(i.line_total),
      })),
      events: events.map((e) => ({
        eventType: e.event_type,
        actorType: e.actor_type,
        actorId: e.actor_id,
        metadata: e.metadata,
        createdAt: e.created_at,
      })),
      notificationsSent: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        sentBy: n.sent_by,
        createdAt: n.created_at,
      })),
      couponsIssued: coupons.map((c) => ({
        id: c.id,
        couponId: c.coupon_id,
        code: c.code,
        discountType: c.discount_type,
        discountValue: c.discount_value !== null ? parseFloat(c.discount_value) : null,
        issuedBy: c.issued_by,
        createdAt: c.created_at,
      })),
    }
  }
}
