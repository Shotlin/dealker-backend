import fp from 'fastify-plugin'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import jwt from 'jsonwebtoken'
import { redis } from '../config/redis.js'
import { query } from '../config/database.js'
import { socketAuthMiddleware } from '../socket/auth.js'
import { nextEventSeq } from '../modules/orders/order-events.js'

const RIDER_LOCATION_PREFIX = 'rider:location:'
const RIDER_LOCATION_TTL = 300 // 5 minutes
let activeIo = null

function expandLoopbackOrigins(originList) {
  const expanded = new Set(originList)

  for (const origin of originList) {
    try {
      const url = new URL(origin)
      if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1'
        expanded.add(url.toString().replace(/\/$/, ''))
      } else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost'
        expanded.add(url.toString().replace(/\/$/, ''))
      }
    } catch {
      expanded.add(origin)
    }
  }

  return Array.from(expanded)
}

export function getSocketIo() {
  return activeIo
}

// `storeKey`/`shopId` let every client decide LOCALLY whether this event is
// about the storefront it is currently showing, instead of every connected
// device (every shop, every store) re-fetching on every edit anywhere.
// `shopId` is null for a change to the shop-less/global theme — that
// genuinely can affect any shop that has no override of its own, so clients
// must not narrow on a null shopId, only on a concrete one.
export function emitSectionUpdate(io, { tabKey, storeKey = null, shopId = null, action }) {
  if (!io) return

  io.to('themes:live').emit('section:update', {
    tab_key: tabKey,
    store_key: storeKey,
    shop_id: shopId,
    action,
    timestamp: Date.now(),
  })
  logger.info({ tabKey, storeKey, shopId, action }, 'Section update broadcasted to all users')
}

/**
 * Socket.IO plugin for Fastify
 * Handles realtime: rider location, order status, notifications, multi-vendor events
 *
 * Rooms:
 *   user:{userId}       — personal room for order updates + notifications
 *   order:{orderId}     — order tracking room (customer + rider + admin)
 *   riders:online       — all online riders (admin dashboard)
 *   shop:{shopId}       — shop dashboard users (vendor-scoped events)
 *   hq:global           — HQ users (cross-shop monitoring)
 *   customer:{userId}   — customer app (delivery tracking)
 *   rider:{riderId}     — rider app (assignment/delivery events)
 *   admin:dashboard     — legacy admin dashboard
 *   themes:live         — all users (theme updates)
 */
async function socketioPlugin(fastify) {
  const corsOrigins = expandLoopbackOrigins(
    env.CORS_ORIGINS.split(',').map((s) => s.trim())
  )

  const io = new Server(fastify.server, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  })

  // The bakaloo-worker process (auto-assignment, notifications) runs
  // as a separate Node process with no HTTP server of its own, so it
  // has no real Socket.IO server instance to broadcast from. Without
  // this adapter, events the worker tries to emit (order:assigned,
  // auto_assignment_failed, theme/section updates) are silent no-ops
  // — `getSocketIo()` in that process always returns null. The
  // adapter lets this server receive broadcasts published over Redis
  // by the worker's redis-emitter (see plugins/socket-emitter.js) and
  // deliver them to the real connected clients.
  const pubClient = redis.duplicate()
  const subClient = redis.duplicate()
  io.adapter(createAdapter(pubClient, subClient))

  // ─── AUTH MIDDLEWARE ──────────────────────────────────
  io.use(socketAuthMiddleware)

  // ─── CONNECTION HANDLER ──────────────────────────────
  io.on('connection', (socket) => {
    const { id: userId, role, platform_role, shopId } = socket.user

    logger.info({ userId, socketId: socket.id, role, platform_role, shopId }, 'Socket connected')

    // Auto-join personal room
    socket.join(`user:${userId}`)

    // ─── MULTI-VENDOR ROOM SCOPING (Task 14.1) ──────
    // HQ users (platform_role set) join hq:global for cross-shop events
    if (platform_role) {
      socket.join('hq:global')
      logger.debug({ userId, room: 'hq:global' }, 'Joined HQ global room')
    }

    // Shop-scoped dashboard users join shop:{shopId} for shop-specific events
    if (shopId) {
      socket.join(`shop:${shopId}`)
      logger.debug({ userId, shopId, room: `shop:${shopId}` }, 'Joined shop room')
    }

    // Customer users join customer:{userId} for personal delivery updates
    if (role === 'CUSTOMER') {
      socket.join(`customer:${userId}`)
    }

    // Rider users join rider:{userId} for assignment/delivery events
    if (role === 'RIDER') {
      socket.join(`rider:${userId}`)
    }

    // ─── RIDER EVENTS ────────────────────────────────
    if (role === 'RIDER') {
      socket.join('riders:online')

      // Rider sends location updates
      socket.on('rider:location', async (data) => {
        try {
          const latitude = Number(data?.latitude ?? data?.lat)
          const longitude = Number(data?.longitude ?? data?.lng)
          const orderId = data?.orderId

          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return
          }

          // Store in Redis (fast reads for proximity)
          await redis.setex(
            `${RIDER_LOCATION_PREFIX}${userId}`,
            RIDER_LOCATION_TTL,
            JSON.stringify({ lat: latitude, lng: longitude, updatedAt: Date.now() })
          )

          // Persist latest coordinates in DB for assignment fallback.
          await query(
            `UPDATE rider_profiles
             SET current_lat = $1, current_lng = $2, updated_at = NOW(),
                 location_updated_at = NOW()
             WHERE user_id = $3`,
            [latitude, longitude, userId]
          )

          // Broadcast to order room (customer tracking)
          if (orderId) {
            io.to(`order:${orderId}`).emit('rider:location:update', {
              orderId,
              riderId: userId,
              latitude,
              longitude,
              timestamp: Date.now(),
            })
          }

          // Broadcast to the admin dashboard ONLY. This used to target the
          // `riders:online` room, which every rider socket joins — so each
          // rider received every other rider's live coordinates.
          io.to('admin:dashboard').emit('rider:location:bulk', {
            riderId: userId,
            latitude,
            longitude,
            timestamp: Date.now(),
          })
        } catch (err) {
          logger.error({ err, userId }, 'Rider location update failed')
        }
      })

      // Rider goes offline
      socket.on('rider:offline', async () => {
        await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)
        socket.leave('riders:online')
        logger.info({ userId }, 'Rider went offline')
      })
    }

    // ─── ORDER TRACKING (Spec §7.15.2, §11.44.1) ──────────────────────
    // Remove arbitrary order:track join without authorization.
    // Authorize every room join through DB object policy.
    socket.on('order:track', async (orderId) => {
      if (!orderId) return
      try {
        if (platform_role || role === 'ADMIN') {
          socket.join(`order:${orderId}`)
          logger.debug({ userId, orderId }, 'HQ/Admin joined order tracking room')
          return
        }

        // DB check for order ownership or rider assignment
        const { rows } = await query(
          `SELECT o.id
             FROM orders o
             LEFT JOIN delivery_assignments da ON da.order_id = o.id AND da.rider_id = $2
            WHERE o.id = $1 AND (o.customer_id = $2 OR da.id IS NOT NULL)
            LIMIT 1`,
          [orderId, userId]
        )

        if (rows.length > 0) {
          socket.join(`order:${orderId}`)
          logger.debug({ userId, orderId }, 'Authorized user joined order tracking room')
        } else {
          logger.warn({ userId, orderId }, 'Unauthorized attempt to join order tracking room rejected')
          socket.emit('error', { code: 'UNAUTHORIZED_ROOM_JOIN', message: 'Unauthorized room join attempt' })
        }
      } catch (err) {
        logger.error({ err, userId, orderId }, 'Failed to authorize order tracking room join')
      }
    })

    socket.on('order:untrack', (orderId) => {
      if (orderId) {
        socket.leave(`order:${orderId}`)
      }
    })

    // ─── ADMIN EVENTS ────────────────────────────────
    if (role === 'ADMIN') {
      socket.join('admin:dashboard')
    }

    // ─── THEME EVENTS ────────────────────────────────
    // All authenticated users join themes:live room for real-time theme updates
    socket.join('themes:live')

    // ─── DISCONNECT ──────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected')

      // Clean up rider location on disconnect
      if (role === 'RIDER') {
        await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)
      }
    })
  })

  // ─── DECORATE FASTIFY ────────────────────────────────
  fastify.decorate('io', io)
  activeIo = io

  // Helper: emit order status update to customer + rider + admin (+ the
  // order's shop dashboard room when the payload carries `shopId`).
  //
  // Every event carries `eventId` + a strictly-increasing `seq` so clients
  // can drop duplicates and out-of-order deliveries, and is published with a
  // SINGLE multi-room emit — socket.io delivers once per socket even when a
  // socket (the customer: `user:{id}` + `order:{id}`) is in several of the
  // target rooms. Previously this was 3+ separate emits, so a customer
  // received every status update twice.
  fastify.decorate('emitOrderUpdate', (orderId, userIdsOrData, maybeData) => {
    const payload = maybeData === undefined ? userIdsOrData : maybeData
    const userIds = maybeData === undefined
      ? []
      : Array.isArray(userIdsOrData)
        ? userIdsOrData.filter(Boolean)
        : userIdsOrData
          ? [userIdsOrData]
          : []
    const seq = payload?.seq ?? nextEventSeq()
    const data = {
      orderId,
      timestamp: new Date(seq).toISOString(),
      ...(payload || {}),
      eventId: payload?.eventId ?? `order:${orderId}:${seq}`,
      seq,
    }

    const rooms = new Set(['admin:dashboard', `order:${orderId}`])
    for (const userId of userIds) rooms.add(`user:${userId}`)
    if (data.shopId) rooms.add(`shop:${data.shopId}`)
    io.to([...rooms]).emit('order:status', data)
  })

  fastify.decorate('emitOrderAssignedToRider', (riderId, data) => {
    if (!riderId) return
    io.to(`user:${riderId}`).emit('order:assigned', data)
  })

  fastify.decorate('emitOrderExpiredToRider', (riderId, data) => {
    if (!riderId) return
    io.to(`user:${riderId}`).emit('order:expired', data)
  })

  // Helper: send personal notification to user
  fastify.decorate('emitNotification', (userId, notification) => {
    io.to(`user:${userId}`).emit('notification', notification)
  })

  // Helper: get rider's latest location from Redis
  fastify.decorate('getRiderLocation', async (riderId) => {
    const data = await redis.get(`${RIDER_LOCATION_PREFIX}${riderId}`)
    return data ? JSON.parse(data) : null
  })

  // ─── ADMIN DASHBOARD EVENTS ──────────────────────────
  // Helper: emit new order alert to admin dashboard. Also reaches
  // shop:{shopId} — a branch/shop-staff dashboard session only ever joins
  // that room (never admin:dashboard, which is HQ-only, see the connection
  // handler above), so without this a store-level user would never see a
  // real-time alert for their own branch's orders at all.
  fastify.decorate('emitDashboardNewOrder', (order) => {
    io.to('admin:dashboard').emit('dashboard:new_order', order)
    if (order?.shop_id) {
      io.to(`shop:${order.shop_id}`).emit('dashboard:new_order', order)
    }
  })

  // Helper: emit low stock alert to admin dashboard
  fastify.decorate('emitDashboardLowStock', (product) => {
    io.to('admin:dashboard').emit('dashboard:low_stock', product)
  })

  // Helper: emit payment received to admin dashboard
  fastify.decorate('emitDashboardPayment', (payment) => {
    io.to('admin:dashboard').emit('dashboard:payment_received', payment)
  })

  // Helper: emit an abandoned-cart status transition (RECOVERED/CONVERTED)
  // to the admin dashboard so an open Abandoned Carts list updates live
  // without polling. The live "elapsed since X" timer itself is pure
  // client-side setInterval math — this event only fires on status changes.
  fastify.decorate('emitAbandonedCartUpdate', (payload) => {
    io.to('admin:dashboard').emit('abandoned_cart:update', payload)
  })

  // Helper: broadcast theme update to ALL connected users
  fastify.decorate('emitThemeUpdate', (tabKey, themeId) => {
    io.to('themes:live').emit('theme:update', {
      tabKey,
      themeId,
      timestamp: new Date().toISOString(),
    })
    logger.info({ tabKey, themeId }, 'Theme update broadcasted to all users')
  })

  // ─── MULTI-VENDOR EVENT HELPERS (Task 14.2) ──────────
  // Emit shop.low_stock to shop:{shopId} room
  // Triggered when stock drops to or below threshold but remains > 0
  fastify.decorate('emitShopLowStock', (shopId, payload) => {
    if (!shopId) return
    io.to(`shop:${shopId}`).emit('shop.low_stock', {
      shop_id: shopId,
      ...payload,
      timestamp: new Date().toISOString(),
    })
    logger.debug({ shopId, event: 'shop.low_stock' }, 'Low stock event emitted to shop room')
  })

  // Emit shop.stock_out to shop:{shopId} room
  // Triggered when stock reaches exactly 0
  fastify.decorate('emitShopStockOut', (shopId, payload) => {
    if (!shopId) return
    io.to(`shop:${shopId}`).emit('shop.stock_out', {
      shop_id: shopId,
      ...payload,
      timestamp: new Date().toISOString(),
    })
    logger.debug({ shopId, event: 'shop.stock_out' }, 'Stock out event emitted to shop room')
  })

  // Emit order.auto_assignment_failed to hq:global room
  // Triggered when auto-assignment cannot proceed (e.g. shop missing coordinates)
  fastify.decorate('emitAutoAssignmentFailed', (payload) => {
    io.to('hq:global').emit('order.auto_assignment_failed', {
      ...payload,
      timestamp: new Date().toISOString(),
    })
    logger.info({ orderId: payload?.order_id, event: 'order.auto_assignment_failed' }, 'Auto-assignment failed event emitted to HQ')
  })

  // Emit OUT_FOR_DELIVERY events to all relevant rooms:
  //   - customer:{userId} (rider info + live coords)
  //   - shop:{shopId} (order picked up notification)
  //   - rider:{riderId} (confirmation)
  //   - hq:global (global delivery monitoring)
  fastify.decorate('emitOutForDelivery', ({ orderId, shopId, customerId, riderId, riderName, riderPhone, orderNumber }) => {
    const basePayload = {
      order_id: orderId,
      order_number: orderNumber || null,
      timestamp: new Date().toISOString(),
    }

    // Customer channel — rider details for tracking
    if (customerId) {
      io.to(`customer:${customerId}`).emit('order.out_for_delivery', {
        ...basePayload,
        rider: { id: riderId, name: riderName || null, phone: riderPhone || null },
      })
    }

    // Shop channel — order picked up
    if (shopId) {
      io.to(`shop:${shopId}`).emit('order.out_for_delivery', {
        ...basePayload,
        rider_id: riderId,
        shop_id: shopId,
      })
    }

    // Rider channel — pickup confirmed
    if (riderId) {
      io.to(`rider:${riderId}`).emit('order.out_for_delivery', {
        ...basePayload,
        rider_id: riderId,
      })
    }

    // HQ global — delivery monitoring
    io.to('hq:global').emit('order.out_for_delivery', {
      ...basePayload,
      shop_id: shopId || null,
      rider_id: riderId || null,
      customer_id: customerId || null,
    })

    logger.info({ orderId, shopId, riderId, event: 'order.out_for_delivery' }, 'OUT_FOR_DELIVERY events emitted to all channels')
  })

  // Periodic: broadcast all rider locations to admin dashboard every 10s
  const riderLocationInterval = setInterval(async () => {
    try {
      // Task 13.5: Use SCAN-based pattern matching instead of KEYS *
      const keys = []
      let cursor = '0'
      do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${RIDER_LOCATION_PREFIX}*`, 'COUNT', 100)
        cursor = nextCursor
        if (batch.length > 0) keys.push(...batch)
      } while (cursor !== '0')

      if (keys.length === 0) return

      const pipeline = redis.pipeline()
      keys.forEach(k => pipeline.get(k))
      const results = await pipeline.exec()

      const locations = keys.map((key, i) => {
        const riderId = key.replace(RIDER_LOCATION_PREFIX, '')
        const data = results[i][1] ? JSON.parse(results[i][1]) : null
        return data ? { riderId, ...data } : null
      }).filter(Boolean)

      if (locations.length > 0) {
        io.to('admin:dashboard').emit('dashboard:rider_locations', locations)
      }
    } catch (err) {
      logger.error({ err }, 'Rider location broadcast failed')
    }
  }, 10000)

  // Cleanup interval on close
  fastify.addHook('onClose', () => {
    clearInterval(riderLocationInterval)
    io.close()
    pubClient.quit().catch(() => {})
    subClient.quit().catch(() => {})
  })

  logger.info('Socket.IO initialized')
}

export default fp(socketioPlugin, {
  name: 'socketio',
})
