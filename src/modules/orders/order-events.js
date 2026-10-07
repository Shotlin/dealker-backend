import { getSocketIo } from '../../plugins/socketio.plugin.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'
import { logger } from '../../config/logger.js'
import { query } from '../../config/database.js'

/**
 * Canonical order / refund realtime events.
 *
 * Every client (customer app, rider app, dashboards) consumes the SAME two
 * events over the Socket.IO connection that already exists for the app:
 *
 *   order:status   — an order moved to a new status
 *   refund:status  — a refund request was raised / approved / rejected / ...
 *
 * Each event carries:
 *   eventId — globally unique, lets a client drop a duplicate delivery
 *   seq     — strictly increasing (per API process) integer, lets a client
 *             drop an out-of-order / stale event (`seq <= lastSeenSeq`)
 *   status  — the AUTHORITATIVE new state, so a client can render it
 *             immediately and then reconcile with one REST read
 *
 * A single multi-room emit is used (socket.io de-duplicates a socket that is
 * in several of the target rooms), so the customer — who is in both
 * `user:{id}` and `order:{id}` — gets exactly one copy, not one per room.
 */

let lastSeq = 0

/** Strictly-increasing sequence — wall clock ms, bumped on collision. */
export function nextEventSeq(now = Date.now()) {
  lastSeq = Math.max(now, lastSeq + 1)
  return lastSeq
}

export function newEventId(orderId, kind, seq) {
  return `${kind}:${orderId}:${seq}`
}

/** Rooms an order event must reach. Pure — unit tested. */
export function orderEventRooms({ orderId, customerId, riderId, shopId }) {
  const rooms = new Set(['admin:dashboard'])
  if (orderId) rooms.add(`order:${orderId}`)
  if (customerId) rooms.add(`user:${customerId}`)
  if (riderId) rooms.add(`user:${riderId}`)
  if (shopId) rooms.add(`shop:${shopId}`)
  return [...rooms]
}

/** Builds the wire payload for `order:status`. Pure — unit tested. */
export function buildOrderStatusPayload({
  orderId, orderNumber, status, timelineType, message, shopId, extra,
}, seq = nextEventSeq()) {
  return {
    orderId,
    orderNumber: orderNumber ?? undefined,
    status,
    timelineType: timelineType || status,
    message: message ?? undefined,
    shopId: shopId ?? undefined,
    eventId: newEventId(orderId, 'order', seq),
    seq,
    timestamp: new Date(seq).toISOString(),
    ...(extra || {}),
  }
}

export function buildRefundStatusPayload({
  orderId, orderNumber, refundRequestId, status, amount, refundTo, adminNote, shopId, event,
}, seq = nextEventSeq()) {
  return {
    orderId,
    orderNumber: orderNumber ?? undefined,
    refundRequestId,
    status,
    event: event || `REFUND_${status}`,
    amount: amount != null ? Number(amount) : undefined,
    refundTo: refundTo ?? undefined,
    adminNote: adminNote ?? undefined,
    shopId: shopId ?? undefined,
    eventId: newEventId(refundRequestId, 'refund', seq),
    seq,
    timestamp: new Date(seq).toISOString(),
  }
}

function resolveIo(io) {
  // API process: the real server. Worker process: redis-emitter, which the
  // API's redis adapter turns into deliveries to the connected sockets.
  return io || getSocketIo() || getSocketEmitter()
}

function emitToRooms(io, rooms, event, payload) {
  const target = resolveIo(io)
  // Single publish to every room (socket.io de-dupes per socket).
  target.to(rooms).emit(event, payload)
}

/**
 * Publishes `order:status`. Never throws — the DB write that triggered the
 * event has already committed, realtime is best-effort and every client
 * reconciles with REST on reconnect/resume anyway.
 *
 * `order` needs: id, order_number?, customer_id, rider_id?, shop_id?
 */
export function publishOrderStatus(order, status, { message, timelineType, io, extra } = {}) {
  try {
    const payload = buildOrderStatusPayload({
      orderId: order.id,
      orderNumber: order.order_number,
      status,
      timelineType,
      message,
      shopId: order.shop_id,
      extra,
    })
    emitToRooms(io, orderEventRooms({
      orderId: order.id,
      customerId: order.customer_id,
      riderId: order.rider_id,
      shopId: order.shop_id,
    }), 'order:status', payload)
    return payload
  } catch (err) {
    logger.warn({ err: err?.message, orderId: order?.id, status }, 'order:status publish failed (non-blocking)')
    return null
  }
}

/** Same, but looks the order up first — for writers that only hold an id. */
export async function publishOrderStatusById(orderId, status, opts = {}) {
  try {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.customer_id, o.shop_id,
              (SELECT da.rider_id FROM delivery_assignments da
                WHERE da.order_id = o.id
                ORDER BY da.created_at DESC LIMIT 1) AS rider_id
         FROM orders o WHERE o.id = $1`,
      [orderId]
    )
    if (!rows[0]) return null
    return publishOrderStatus(rows[0], status, opts)
  } catch (err) {
    logger.warn({ err: err?.message, orderId, status }, 'order:status lookup/publish failed (non-blocking)')
    return null
  }
}

/**
 * Publishes `refund:status` to the customer, the order room, the store
 * dashboard and HQ.
 */
export function publishRefundStatus(refund, { io, event } = {}) {
  try {
    const payload = buildRefundStatusPayload({
      orderId: refund.order_id,
      orderNumber: refund.order_number,
      refundRequestId: refund.id,
      status: refund.status === 'PROCESSING' ? 'PENDING' : refund.status,
      amount: refund.resolved_amount ?? refund.computed_amount,
      refundTo: refund.refund_destination,
      adminNote: refund.admin_notes,
      shopId: refund.shop_id,
      event,
    })
    emitToRooms(io, orderEventRooms({
      orderId: refund.order_id,
      customerId: refund.customer_id,
      shopId: refund.shop_id,
    }), 'refund:status', payload)
    return payload
  } catch (err) {
    logger.warn({ err: err?.message, refundId: refund?.id }, 'refund:status publish failed (non-blocking)')
    return null
  }
}

/**
 * For writers that have no Fastify instance (Shiprocket poller, workers):
 * records the in-app notification + push exactly like the admin/rider paths
 * do (same `buildCustomerOrderEventNotification` copy and per-stage settings),
 * then publishes `order:status`. Never throws.
 */
export async function announceOrderStatusById(orderId, status, { message } = {}) {
  try {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.customer_id, o.shop_id,
              (SELECT da.rider_id FROM delivery_assignments da
                WHERE da.order_id = o.id ORDER BY da.created_at DESC LIMIT 1) AS rider_id
         FROM orders o WHERE o.id = $1`,
      [orderId]
    )
    const order = rows[0]
    if (!order) return null

    try {
      const [{ NotificationsService }, { NotificationsRepository }, { buildCustomerOrderEventNotification }] =
        await Promise.all([
          import('../notifications/notifications.service.js'),
          import('../notifications/notifications.repository.js'),
          import('../notifications/customer-order-event.helper.js'),
        ])
      const shim = { emitNotification: (userId, n) => resolveIo().to(`user:${userId}`).emit('notification', n) }
      await new NotificationsService(new NotificationsRepository(), shim).sendNotification(
        order.customer_id,
        buildCustomerOrderEventNotification({
          orderId: order.id, orderNumber: order.order_number, timelineType: status, status,
        })
      )
    } catch (err) {
      logger.warn({ err: err?.message, orderId, status }, 'order status notification failed (non-blocking)')
    }

    return publishOrderStatus(order, status, { message })
  } catch (err) {
    logger.warn({ err: err?.message, orderId, status }, 'announceOrderStatusById failed (non-blocking)')
    return null
  }
}
