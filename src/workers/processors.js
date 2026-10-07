import { sendPush } from '../utils/pushNotification.js'
import { sendSmsOtp } from '../utils/sms.js'
import { logger } from '../config/logger.js'
import { getClient, query } from '../config/database.js'
import { redis } from '../config/redis.js'
import { orderQueue } from '../config/bullmq.js'
import { getSocketEmitter } from '../plugins/socket-emitter.js'
import { cacheDeletePattern } from '../utils/cache.js'
import { ACTIVE_THEME_CACHE_PREFIX, LEGACY_TAB_CACHE_KEY } from '../modules/themes/theme-cache.js'
import { emit as emitAudit } from '../utils/audit-log.js'
import {
  evaluateLocationFreshness,
  logStaleLocationSkips,
  buildCandidateQuery,
  applyPoolCap,
} from './dispatch-eligibility.js'
import {
  ASSIGNABLE_ORDER_STATUSES,
  CLAIMED_ASSIGNMENT_STATUSES,
  OPEN_ASSIGNMENT_STATUSES,
} from '../constants/delivery-statuses.js'

const DEFAULT_RIDER_EARNING = 25
// Notification channel the rider app creates (notification_service.dart) —
// a push naming a channel the device doesn't have falls back to Android's
// low-priority default, so rider pushes must name this one.
const RIDER_PUSH_CHANNEL_ID = 'meetcommerce_rider_high'
// Auto-assign fans out to every online rider sorted by distance with no
// cutoff — without this, a rider hundreds/thousands of km from the
// pickup store (anywhere with no other online riders nearby) gets
// offered the delivery, since "closest of all candidates" still
// matches even when the closest candidate is absurdly far away.
const MAX_AUTO_ASSIGN_DISTANCE_KM =
  Number(process.env.AUTO_ASSIGN_MAX_DISTANCE_KM) || 15

const RIDER_DECLINE_REASONS = new Set([
  'TOO_FAR',
  'VEHICLE_ISSUE',
  'PERSONAL_REASON',
  'OTHER',
])

/**
 * Process notification jobs
 * Job types: push, in-app, order-status, sms-otp
 */
export async function processNotificationJob(job) {
  const { type } = job.data

  switch (type) {
    case 'push':
      return handlePushNotification(job.data)

    case 'in-app':
      return handleInAppNotification(job.data)

    case 'order-status':
      return handleOrderStatusNotification(job.data)

    default:
      logger.warn({ type, jobId: job.id }, 'Unknown notification job type')
  }
}

/**
 * Process SMS jobs (OTP delivery)
 */
export async function processSmsJob(job) {
  const { phone } = job.data
  const result = await sendSmsOtp(phone)

  if (!result.success) {
    throw new Error(result.message || 'SMS send failed')
  }

  return result
}

/**
 * Process theme jobs (scheduled activation, asset warmup)
 */
export async function processThemeJob(job) {
  const { type } = job.data

  switch (type) {
    case 'scheduled-activation':
      return handleScheduledActivation(job.data)

    case 'apply-section-layout':
      return handleApplySectionLayout(job.data)

    case 'asset-warmup':
      return handleAssetWarmup(job.data)

    default:
      logger.warn({ type, jobId: job.id }, 'Unknown theme job type')
  }
}

// ─── HANDLERS ────────────────────────────────────────────

async function handlePushNotification({ userId, title, body, data }) {
  // Get user's FCM tokens
  const { rows: tokens } = await query(
    "SELECT token FROM fcm_tokens WHERE user_id = $1 AND app = 'customer' AND is_active = true",
    [userId]
  )

  if (!tokens.length) {
    logger.debug({ userId }, 'No FCM tokens — skipping push')
    return
  }

  for (const { token } of tokens) {
    await sendPush(token, { title, body, data })
  }
}

async function handleInAppNotification({ userId, title, body, notificationType, data }) {
  await query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body, notificationType || 'general', JSON.stringify(data || {})]
  )
}

async function handleOrderStatusNotification({ orderId, userId, status, orderNumber }) {
  const messages = {
    CONFIRMED: { title: 'Order Confirmed! 🎉', body: `Your order ${orderNumber} has been confirmed.` },
    PREPARING: { title: 'Order Being Prepared 🍳', body: `Your order ${orderNumber} is being prepared.` },
    PACKED: { title: 'Order Packed 📦', body: `Your order ${orderNumber} has been packed and is ready for pickup.` },
    OUT_FOR_DELIVERY: { title: 'Out for Delivery 🚴', body: `Your order ${orderNumber} is on its way!` },
    DELIVERED: { title: 'Order Delivered ✅', body: `Your order ${orderNumber} has been delivered. Enjoy!` },
    CANCELLED: { title: 'Order Cancelled ❌', body: `Your order ${orderNumber} has been cancelled.` },
  }

  const msg = messages[status]
  if (!msg) return

  // Create in-app notification
  await query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     VALUES ($1, $2, $3, 'order', $4)`,
    [userId, msg.title, msg.body, JSON.stringify({ orderId, status })]
  )

  // Send push notification
  const { rows: tokens } = await query(
    "SELECT token FROM fcm_tokens WHERE user_id = $1 AND app = 'customer' AND is_active = true",
    [userId]
  )

  for (const { token } of tokens) {
    await sendPush(token, {
      title: msg.title,
      body: msg.body,
      data: { orderId, status, type: 'order_status' },
    })
  }
}

async function handleScheduledActivation({ themeId }) {
  if (!themeId) {
    logger.warn('Scheduled activation: missing themeId')
    return
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')

    const { rows: [theme] } = await client.query(
      `SELECT theme.id, theme.tab_id, theme.tab_key, theme.ab_variant, theme.shop_id, tab.store_key
       FROM app_themes theme
       LEFT JOIN theme_tabs tab ON tab.id = theme.tab_id
       WHERE theme.id = $1`,
      [themeId]
    )

    if (!theme) {
      await client.query('ROLLBACK')
      logger.warn({ themeId }, 'Scheduled activation: theme not found')
      return
    }

    if (theme.tab_id) {
      await client.query(
        `UPDATE app_themes
         SET status = 'draft', updated_at = NOW()
         WHERE tab_id = $1
           AND ab_variant = $2
           AND id <> $3
           AND status = 'active'`,
        [theme.tab_id, theme.ab_variant, themeId]
      )
    }

    const shouldUpdateActiveFlag =
      theme.tab_key === 'all' &&
      theme.ab_variant === 'A' &&
      theme.store_key === 'marketplace'

    if (shouldUpdateActiveFlag) {
      // Scoped to the same shop bucket (NULL-safe) — see themes.repository.js#activate.
      await client.query(
        `UPDATE app_themes
            SET is_active = false, updated_at = NOW()
          WHERE is_active = true
            AND shop_id IS NOT DISTINCT FROM $1`,
        [theme.shop_id ?? null]
      )
    }

    await client.query(
      `UPDATE app_themes
       SET status = 'active',
           scheduled_at = NULL,
           is_active = CASE WHEN $2 THEN true ELSE is_active END,
           updated_at = NOW()
       WHERE id = $1`,
      [themeId, shouldUpdateActiveFlag]
    )

    await client.query('COMMIT')

    await cacheDeletePattern(`${ACTIVE_THEME_CACHE_PREFIX}:*`)
    await redis.del(LEGACY_TAB_CACHE_KEY)
    await cacheDeletePattern('bakaloo:tab_manifest:*')
    await cacheDeletePattern('bakaloo:tab_home:*')
    await cacheDeletePattern('bakaloo:admin_theme_tabs:*')

    const io = getSocketEmitter()
    if (io) {
      io.to('themes:live').emit('theme:update', {
        tabKey: theme.tab_key,
        storeKey: theme.store_key || 'marketplace',
        themeId,
        timestamp: new Date().toISOString(),
      })
      logger.info({ tabKey: theme.tab_key, storeKey: theme.store_key || 'marketplace', themeId }, 'Theme update broadcasted to all users')
    }

    logger.info({ themeId, tabKey: theme.tab_key, storeKey: theme.store_key || 'marketplace' }, 'Theme auto-activated by schedule')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err, themeId }, 'Scheduled activation failed')
    throw err
  } finally {
    client.release()
  }
}

async function handleAssetWarmup({ urls }) {
  if (!Array.isArray(urls)) return

  for (const url of urls) {
    try {
      await fetch(url, { method: 'HEAD' })
    } catch (err) {
      logger.debug({ url, err: err.message }, 'Asset warmup failed for URL')
    }
  }

  logger.info({ count: urls.length }, 'Theme asset warmup completed')
}

async function handleApplySectionLayout({ versionId, tabId }) {
  if (!versionId || !tabId) {
    logger.warn({ versionId, tabId }, 'Scheduled section layout: missing versionId or tabId')
    return
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')

    const { rows: [version] } = await client.query(
      `SELECT
         version.id,
         version.tab_id,
         version.snapshot,
         version.status,
         tab.key AS tab_key,
         tab.store_key
       FROM section_manifest_versions version
       JOIN theme_tabs tab ON tab.id = version.tab_id
       WHERE version.id = $1
         AND version.tab_id = $2`,
      [versionId, tabId]
    )

    if (!version) {
      await client.query('ROLLBACK')
      logger.warn({ versionId, tabId }, 'Scheduled section layout: version not found')
      return
    }

    if (version.status !== 'scheduled') {
      await client.query('ROLLBACK')
      logger.info({ versionId, tabId, status: version.status }, 'Scheduled section layout skipped')
      return
    }

    await client.query('DELETE FROM section_manifests WHERE tab_id = $1', [tabId])

    const snapshot = Array.isArray(version.snapshot) ? version.snapshot : []
    const orderedSnapshot = [...snapshot].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    )

    for (const section of orderedSnapshot) {
      await client.query(
        `INSERT INTO section_manifests (
           tab_id,
           section_type,
           sort_order,
           visible,
           config,
           merch_binding
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          tabId,
          section.section_type,
          section.sort_order ?? 0,
          section.visible ?? true,
          JSON.stringify(section.config || {}),
          section.merch_binding ? JSON.stringify(section.merch_binding) : null,
        ]
      )
    }

    await client.query(
      `UPDATE section_manifest_versions
       SET status = 'applied',
           scheduled_at = NULL
       WHERE id = $1`,
      [versionId]
    )

    await client.query('COMMIT')

    await cacheDeletePattern('bakaloo:sections:*')
    await cacheDeletePattern('bakaloo:tab_manifest:*')
    await cacheDeletePattern('bakaloo:tab_home:*')

    const io = getSocketEmitter()
    if (io) {
      io.to('themes:live').emit('section:update', {
        tab_key: version.tab_key,
        store_key: version.store_key || 'marketplace',
        action: 'schedule',
        timestamp: new Date().toISOString(),
      })
    }

    logger.info({ versionId, tabId, tabKey: version.tab_key }, 'Scheduled section layout applied')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err, versionId, tabId }, 'Scheduled section layout failed')
    throw err
  } finally {
    client.release()
  }
}

async function handleAutoConfirm({ orderId }) {
  const { rows } = await query(
    `UPDATE orders SET status = 'CONFIRMED', updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING id, order_number, user_id`,
    [orderId]
  )

  if (rows[0]) {
    await queueAutoAssign(rows[0].id, 'AUTO_CONFIRM')
    logger.info({ orderId }, 'Order auto-confirmed')
  }
}

async function handleAssignmentTimeout({ assignmentId, orderId }) {
  logger.info(
    { assignmentId, orderId },
    'Ignoring legacy assignment-timeout job because persistent offers are enabled'
  )
  return { ignored: true }
}

export async function clearLegacyAssignmentTimeoutJobs() {
  const delayedJobs = await orderQueue.getJobs(['delayed', 'waiting'], 0, 2000)
  let removed = 0

  for (const job of delayedJobs) {
    const type = `${job?.data?.type || ''}`
    if (job?.name === 'assignment-timeout' || type === 'assignment-timeout') {
      await job.remove()
      removed += 1
    }
  }

  return removed
}

async function handleDeliveryReminder({ orderId, riderId }) {
  const { rows: tokens } = await query(
    "SELECT token FROM fcm_tokens WHERE user_id = $1 AND app = 'rider' AND is_active = true",
    [riderId]
  )

  for (const { token } of tokens) {
    await sendPush(token, {
      title: 'Delivery Reminder ⏰',
      body: 'You have a pending delivery. Please pick up the order.',
      data: { orderId, type: 'delivery_reminder' },
      channelId: RIDER_PUSH_CHANNEL_ID,
    })
  }
}

/**
 * Process order jobs (auto-confirm, timeout, assignment)
 */
export async function processOrderJob(job) {
  const { type } = job.data

  switch (type) {
    case 'auto-confirm':
      return handleAutoConfirm(job.data)

    case 'assignment-timeout':
      return handleAssignmentTimeout(job.data)

    case 'delivery-reminder':
      return handleDeliveryReminder(job.data)

    case 'auto-assign':
      return handleAutoAssign(job.data)

    case 'auto-assign-backlog':
      return handleAutoAssignBacklog(job.data)

    default:
      logger.warn({ type, jobId: job.id }, 'Unknown order job type')
  }
}

async function handleAutoAssignBacklog({ limit = 200 } = {}) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Number(limit))) : 200

  const { rows } = await query(
    `SELECT id
     FROM orders
     WHERE status = ANY($1::text[])
       AND rider_id IS NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [ASSIGNABLE_ORDER_STATUSES, safeLimit]
  )

  let queued = 0
  for (const row of rows) {
    const added = await queueAutoAssign(row.id, 'BACKLOG_SCAN')
    if (added) queued++
  }

  logger.info({ scanned: rows.length, queued }, 'Auto-assign backlog scan completed')
  return { scanned: rows.length, queued }
}

async function handleAutoAssign({ orderId, source = 'SYSTEM' }) {
  if (!orderId) {
    return { assigned: false, reason: 'MISSING_ORDER_ID' }
  }

  const { rows: orderRows } = await query(
    `SELECT o.id, o.order_number, o.status, o.rider_id, o.total_payable, o.payment_method,
            o.wallet_amount, o.payment_status,
            o.delivery_fee, o.shop_id,
            o.items, o.delivery_address, o.created_at,
            u.name AS customer_name, u.phone AS customer_phone,
            (SELECT delivery_partner FROM shiprocket_settings LIMIT 1) AS delivery_partner
     FROM orders o
     LEFT JOIN users u ON u.id = o.customer_id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  )
  const order = orderRows[0]

  if (!order) {
    logger.warn({ orderId, source }, 'Auto-assign skipped: order not found')
    return { assigned: false, reason: 'ORDER_NOT_FOUND' }
  }

  // Own riders are paused while Shiprocket Quick is the delivery partner.
  if (order.delivery_partner === 'SHIPROCKET') {
    return { assigned: false, reason: 'SHIPROCKET_MODE' }
  }

  if (!ASSIGNABLE_ORDER_STATUSES.includes(order.status)) {
    return { assigned: false, reason: `ORDER_STATUS_${order.status}` }
  }

  if (order.rider_id) {
    return { assigned: false, reason: 'RIDER_ALREADY_ASSIGNED' }
  }

  const orderAddress = parseAddress(order.delivery_address)
  const customerLat = toNumber(orderAddress.lat ?? orderAddress.latitude)
  const customerLng = toNumber(orderAddress.lng ?? orderAddress.longitude)
  const hasCustomerCoords =
    Number.isFinite(customerLat) && Number.isFinite(customerLng)
  if (!hasCustomerCoords) {
    logger.warn(
      { orderId, orderNumber: order.order_number, source },
      'Offering order with address-only customer destination; rider app will geocode fallback'
    )
  }

  // Task 12.1/12.2: Read pickup coordinates from the order's shop row
  const store = await getShopInfoForOrder(order.shop_id)
  if (!store || !Number.isFinite(store.pickup_lat) || !Number.isFinite(store.pickup_lng)) {
    // Task 12.3: Missing shop coordinates → MANUAL_REQUIRED
    logger.warn({ orderId, shopId: order.shop_id }, 'Auto-assign skipped: shop coordinates missing')
    await query(
      `UPDATE orders SET auto_assignment_status = 'MANUAL_REQUIRED', updated_at = NOW() WHERE id = $1`,
      [orderId]
    )
    const io = getSocketEmitter()
    if (io) {
      io.to('hq:global').emit('order.auto_assignment_failed', {
        orderId,
        orderNumber: order.order_number,
        shopId: order.shop_id || null,
        reason: 'SHOP_COORDS_MISSING',
        timestamp: new Date().toISOString(),
      })
    }
    emitAudit('auto_assignment_failed', {
      actor_user_id: null,
      actor_role: null,
      actor_shop_id: order.shop_id || null,
      target_type: 'order',
      target_id: orderId,
      before: null,
      after: { reason: 'SHOP_COORDS_MISSING', source },
    })
    return { assigned: false, reason: 'SHOP_COORDS_MISSING' }
  }

  // Task 12.2: Select riders with status AVAILABLE, is_active=true, no non-terminal assignment.
  // Big Phase 6: when RIDER_STORE_SCOPING=true, riders must also hold an
  // active assignment for the order's pickup shop (rider_store_assignments).
  const { sql: candidateSql, params: candidateParams } = buildCandidateQuery({
    storeScoping: process.env.RIDER_STORE_SCOPING === 'true',
    shopId: order.shop_id,
  })
  const { rows: candidateRiders } = await query(candidateSql, candidateParams)

  if (!candidateRiders.length) {
    return { assigned: false, reason: 'NO_AVAILABLE_RIDERS' }
  }

  const candidatesWithDistance = []
  let skippedForLocation = 0

  for (const rider of candidateRiders) {
    let lat = toNumber(rider.current_lat)
    let lng = toNumber(rider.current_lng)
    let redisUpdatedAt = null

    try {
      const cached = await redis.get(`rider:location:${rider.user_id}`)
      if (cached) {
        const parsed = JSON.parse(cached)
        redisUpdatedAt = toNumber(parsed.updatedAt, Number.NaN)
        if (!Number.isFinite(redisUpdatedAt)) redisUpdatedAt = null
        lat = toNumber(parsed.lat, lat)
        lng = toNumber(parsed.lng, lng)
      }
    } catch (_) {
      // Ignore Redis parse/cache errors and fallback to DB coordinates.
    }

    // Blueprint §5: the fix itself must be fresh enough for dispatch.
    // Redis hits carry their own updatedAt; the durable fallback is the
    // rider_profiles.location_updated_at column. Riders with no fix at
    // all are not offered orders.
    const freshness = evaluateLocationFreshness({
      redisUpdatedAt,
      dbLocationUpdatedAt: rider.location_updated_at,
    })
    if (!freshness.fresh) {
      skippedForLocation += 1
      continue
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skippedForLocation += 1
      continue
    }

    const resolvedDistance = haversineDistanceKm(store.pickup_lat, store.pickup_lng, lat, lng)
    if (!Number.isFinite(resolvedDistance)) {
      skippedForLocation += 1
      continue
    }

    candidatesWithDistance.push({
      riderId: rider.user_id,
      distanceKm: resolvedDistance,
    })
  }

  logStaleLocationSkips({
    skipped: skippedForLocation,
    total: candidateRiders.length,
    orderId,
    source,
  })

  // Drop riders whose KNOWN distance puts them outside any realistic
  // delivery range. Every remaining candidate now has a finite distance
  // (stale/missing fixes were dropped above).
  const inRangeCandidates = candidatesWithDistance.filter(
    (c) => c.distanceKm <= MAX_AUTO_ASSIGN_DISTANCE_KM
  )

  if (!inRangeCandidates.length) {
    logger.warn(
      {
        orderId,
        orderNumber: order.order_number,
        shopId: order.shop_id,
        candidateCount: candidatesWithDistance.length,
        nearestKnownDistanceKm: candidatesWithDistance
          .map((c) => c.distanceKm)
          .filter((d) => Number.isFinite(d))
          .sort((a, b) => a - b)[0] ?? null,
        maxDistanceKm: MAX_AUTO_ASSIGN_DISTANCE_KM,
      },
      'Auto-assign skipped: no online riders within range of the pickup store'
    )
    return { assigned: false, reason: 'NO_RIDERS_IN_RANGE' }
  }

  inRangeCandidates.sort((a, b) => {
    const aDistance = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY
    const bDistance = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY
    return aDistance - bDistance
  })

  // Architecture §9: only the nearest configured pool receives the
  // offer; everyone else stays untouched. Push/socket fanout below
  // iterates the same truncated list.
  const selectedCandidates = applyPoolCap(inRangeCandidates)
  if (selectedCandidates.length < inRangeCandidates.length) {
    logger.info(
      {
        orderId,
        shopId: order.shop_id,
        inRange: inRangeCandidates.length,
        offered: selectedCandidates.length,
        poolSize: selectedCandidates.length,
      },
      'Auto-assign fanout capped to the configured nearest pool'
    )
  }

  if (!selectedCandidates.length) {
    return { assigned: false, reason: 'NO_AVAILABLE_RIDERS' }
  }

  const client = await getClient()
  let assignments = []
  let hasOpenAssignedOffers = false
  const riderEarning = resolveRiderEarning(order.delivery_fee)

  try {
    await client.query('BEGIN')

    const { rows: lockedRows } = await client.query(
      `SELECT id, status, rider_id
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    )
    const lockedOrder = lockedRows[0]
    if (!lockedOrder) {
      await client.query('ROLLBACK')
      return { assigned: false, reason: 'ORDER_NOT_FOUND_AT_LOCK' }
    }
    if (!ASSIGNABLE_ORDER_STATUSES.includes(lockedOrder.status) || lockedOrder.rider_id) {
      await client.query('ROLLBACK')
      return { assigned: false, reason: 'ORDER_NOT_ASSIGNABLE_AT_LOCK' }
    }

    const { rows: existingAssignments } = await client.query(
      `SELECT id, rider_id, status, cancel_reason, earnings, distance_km, assigned_at, created_at
       FROM delivery_assignments
       WHERE order_id = $1
       ORDER BY assigned_at DESC NULLS LAST, created_at DESC`,
      [orderId]
    )

    if (existingAssignments.some((row) => CLAIMED_ASSIGNMENT_STATUSES.includes(row.status))) {
      await client.query('ROLLBACK')
      return { assigned: false, reason: 'ORDER_ALREADY_CLAIMED_AT_LOCK' }
    }

    const latestAssignmentByRider = new Map()
    hasOpenAssignedOffers = existingAssignments.some((row) => row.status === 'ASSIGNED')
    for (const row of existingAssignments) {
      if (!row?.rider_id || latestAssignmentByRider.has(row.rider_id)) {
        continue
      }
      latestAssignmentByRider.set(row.rider_id, row)
    }

    for (const candidate of selectedCandidates) {
      const existing = latestAssignmentByRider.get(candidate.riderId)

      if (existing && OPEN_ASSIGNMENT_STATUSES.includes(existing.status)) {
        continue
      }

      if (existing && isPermanentDecline(existing.cancel_reason)) {
        continue
      }

      let assignmentRows = []

      if (existing && canReopenCancelledOffer(existing.cancel_reason)) {
        const reopened = await client.query(
          `UPDATE delivery_assignments
           SET status = 'ASSIGNED',
               assigned_at = NOW(),
               accepted_at = NULL,
               picked_up_at = NULL,
               delivered_at = NULL,
               cancelled_at = NULL,
               cancel_reason = NULL,
               delivery_otp = NULL,
               proof_photo_url = NULL,
               earnings = $2,
               distance_km = $3,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, order_id, rider_id, status, assigned_at, earnings, distance_km`,
          [existing.id, riderEarning, candidate.distanceKm]
        )
        assignmentRows = reopened.rows
      } else if (!existing) {
        const inserted = await client.query(
          `INSERT INTO delivery_assignments (
            order_id,
            rider_id,
            status,
            assigned_at,
            earnings,
            distance_km
          )
           SELECT $1, $2, 'ASSIGNED', NOW(), $3, $4
           WHERE NOT EXISTS (
             SELECT 1
             FROM delivery_assignments da
             WHERE da.order_id = $1
               AND da.rider_id = $2
               AND da.status = ANY($5::text[])
           )
           RETURNING id, order_id, rider_id, status, assigned_at, earnings, distance_km`,
          [orderId, candidate.riderId, riderEarning, candidate.distanceKm, OPEN_ASSIGNMENT_STATUSES]
        )
        assignmentRows = inserted.rows
      }

      const inserted = assignmentRows[0]
      if (inserted) {
        latestAssignmentByRider.set(candidate.riderId, inserted)
        assignments.push({
          ...inserted,
          distanceKm: toNumber(inserted.distance_km, candidate.distanceKm),
        })
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err, orderId, source }, 'Auto-assign transaction failed')
    throw err
  } finally {
    client.release()
  }

  if (!assignments.length) {
    // R28.4 — fire-and-forget audit for auto_assignment_failed
    emitAudit('auto_assignment_failed', {
      actor_user_id: null,
      actor_role: null,
      actor_shop_id: order.shop_id || null,
      target_type: 'order',
      target_id: orderId,
      before: null,
      after: {
        reason: hasOpenAssignedOffers
          ? 'OFFERS_ALREADY_SYNCHRONIZED'
          : 'NO_ELIGIBLE_RIDER_OFFERS_CREATED',
        source,
      },
    })

    return {
      assigned: false,
      reason: hasOpenAssignedOffers
        ? 'OFFERS_ALREADY_SYNCHRONIZED'
        : 'NO_ELIGIBLE_RIDER_OFFERS_CREATED',
    }
  }

  const io = getSocketEmitter()

  for (const assignment of assignments) {
    const payload = buildAssignedPayload({
      order,
      assignment,
      store,
      estimatedDistanceKm: assignment.distanceKm,
      riderEarning,
    })
    if (io) {
      io.to(`user:${assignment.rider_id}`).emit('order:assigned', payload)
    }
    await sendAssignedOrderPush({
      riderId: assignment.rider_id,
      payload,
    })
  }

  logger.info(
    {
      orderId,
      assignmentCount: assignments.length,
      riderIds: assignments.map((item) => item.rider_id),
      source,
    },
    'Order auto-assigned with rider fanout'
  )

  return {
    assigned: true,
    orderId,
    offers: assignments.map((item) => ({
      assignmentId: item.id,
      riderId: item.rider_id,
      distanceKm: Number.isFinite(item.distanceKm)
        ? Number(item.distanceKm.toFixed(2))
        : null,
    })),
  }
}

async function queueAutoAssign(orderId, source) {
  if (!orderId) return false

  try {
    await orderQueue.add(
      'auto-assign',
      { type: 'auto-assign', orderId, source },
      {
        jobId: `auto-assign-${orderId}`,
        removeOnComplete: true,
        removeOnFail: true,
      }
    )
    return true
  } catch (err) {
    logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
    return false
  }
}

async function shouldRequeueOrder(orderId) {
  if (!orderId) return false

  const { rows } = await query(
    `SELECT o.id
     FROM orders o
     WHERE o.id = $1
       AND o.status = ANY($3::text[])
       AND o.rider_id IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM delivery_assignments da
         WHERE da.order_id = o.id
           AND da.status = ANY($2::text[])
       )
     LIMIT 1`,
    [orderId, OPEN_ASSIGNMENT_STATUSES, ASSIGNABLE_ORDER_STATUSES]
  )

  return rows.length > 0
}

async function cancelStaleAssignedOffers(orderId) {
  logger.debug({ orderId }, 'Persistent offers enabled; stale-offer cancellation is disabled')
  return 0
}

async function getShopInfoForOrder(shopId) {
  if (!shopId) return null
  const { rows } = await query(
    `SELECT id, name,
            CONCAT_WS(', ', address_line1, address_line2, city, state, pincode) AS address,
            phone, lat AS pickup_lat, lng AS pickup_lng
     FROM shops
     WHERE id = $1
     LIMIT 1`,
    [shopId]
  )
  const row = rows[0]
  if (!row) return null
  return {
    ...row,
    pickup_lat: toNumber(row.pickup_lat),
    pickup_lng: toNumber(row.pickup_lng),
  }
}

async function getStoreSettings() {
  const { rows } = await query(
    `SELECT key, value
     FROM app_settings
     WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
  )

  const settings = {
    lat: 0,
    lng: 0,
    name: 'Bakaloo Store',
    address: 'Pickup location',
    phone: '',
  }

  for (const row of rows) {
    const key = row.key
    const value = normalizeSettingValue(row.value)
    if (key === 'store_lat') settings.lat = toNumber(value, 0)
    if (key === 'store_lng') settings.lng = toNumber(value, 0)
    if (key === 'store_name' && `${value}`.trim()) settings.name = `${value}`.trim()
    if (key === 'store_address' && `${value}`.trim()) settings.address = `${value}`.trim()
    if (key === 'store_phone' && `${value}`.trim()) settings.phone = `${value}`.trim()
  }

  return settings
}

function normalizeSettingValue(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return value.value
    }
    return JSON.stringify(value)
  }
  return ''
}

export function buildAssignedPayload({
  order,
  assignment,
  store,
  estimatedDistanceKm,
  riderEarning,
}) {
  const address = parseAddress(order.delivery_address)
  const safeDistanceKm = Number.isFinite(estimatedDistanceKm)
    ? estimatedDistanceKm
    : Number.isFinite(toNumber(assignment.distance_km))
      ? toNumber(assignment.distance_km)
      : null
  const durationMinutes = safeDistanceKm != null && safeDistanceKm > 0
    ? Math.max(3, Math.round((safeDistanceKm / 20) * 60))
    : 0

  return {
    type: 'ORDER_ASSIGNED',
    orderId: order.id,
    assignmentId: assignment.id,
    orderNumber: order.order_number,
    status: 'ASSIGNED',
    // `orders.total_amount` was renamed `total_payable` by migration 106 —
    // reading the old name made every realtime offer/push carry ₹0.
    totalAmount: toNumber(order.total_payable, 0),
    walletAmount: toNumber(order.wallet_amount, 0),
    // What the rider must collect at the door: total less the wallet slice
    // already paid, nothing once the order is PAID (same rule as
    // DeliveryService#_amountDue).
    amountDue: `${order.payment_status || ''}`.toUpperCase() === 'PAID'
      ? 0
      : Math.max(0, Number((toNumber(order.total_payable, 0) - toNumber(order.wallet_amount, 0)).toFixed(2))),
    paymentMethod: order.payment_method || 'ONLINE',
    estimatedDistance: safeDistanceKm == null
      ? null
      : Number(safeDistanceKm.toFixed(2)),
    estimatedDuration: durationMinutes,
    riderEarning: resolveRiderEarning(assignment.earnings, riderEarning),
    offerTimeoutSeconds: 0,
    offerExpiresAt: null,
    isOfferActive: true,
    items: parseItems(order.items),
    customerAddress: {
      name: order.customer_name || address.name || 'Customer',
      address: resolveAddressText(address),
      landmark: address.landmark || '',
      phone: order.customer_phone || address.phone || '',
      lat: toNumber(address.lat ?? address.latitude, 0),
      lng: toNumber(address.lng ?? address.longitude, 0),
    },
    storeAddress: {
      name: store.name,
      address: store.address,
      landmark: '',
      phone: store.phone,
      lat: store.pickup_lat,
      lng: store.pickup_lng,
    },
  }
}

async function sendAssignedOrderPush({ riderId, payload }) {
  if (!riderId || !payload) {
    return
  }

  const { rows: tokens } = await query(
    "SELECT token FROM fcm_tokens WHERE user_id = $1 AND app = 'rider' AND is_active = true",
    [riderId]
  )

  if (!tokens.length) {
    return
  }

  const itemCount = Array.isArray(payload.items)
    ? payload.items.reduce((total, item) => total + toNumber(item?.quantity, 0), 0)
    : 0
  const body = itemCount > 0
    ? `${itemCount} items • Earn ₹${toNumber(payload.riderEarning, DEFAULT_RIDER_EARNING).toFixed(0)}`
    : `Earn ₹${toNumber(payload.riderEarning, DEFAULT_RIDER_EARNING).toFixed(0)} on this order`
  const pushData = buildAssignedPushData(payload)

  await Promise.allSettled(
    tokens.map(({ token }) =>
      sendPush(token, {
        title: 'New delivery offer',
        body,
        data: pushData,
        channelId: RIDER_PUSH_CHANNEL_ID,
      })
    )
  )
}

function buildAssignedPushData(payload) {
  const pushPayload = {
    type: payload.type || 'ORDER_ASSIGNED',
    orderId: payload.orderId,
    assignmentId: payload.assignmentId,
    orderNumber: payload.orderNumber,
    status: payload.status,
    totalAmount: payload.totalAmount,
    amountDue: payload.amountDue,
    walletAmount: payload.walletAmount,
    paymentMethod: payload.paymentMethod,
    estimatedDistance: payload.estimatedDistance ?? '',
    estimatedDuration: payload.estimatedDuration ?? '',
    riderEarning: payload.riderEarning,
    offerTimeoutSeconds: payload.offerTimeoutSeconds,
    offerExpiresAt: payload.offerExpiresAt ?? '',
    isOfferActive: payload.isOfferActive ?? true,
    items: JSON.stringify(payload.items || []),
    customerAddress: JSON.stringify(payload.customerAddress || {}),
    storeAddress: JSON.stringify(payload.storeAddress || {}),
  }

  return Object.fromEntries(
    Object.entries(pushPayload).filter(([, value]) => value !== null && value !== undefined)
  )
}

function canReopenCancelledOffer(cancelReason) {
  return normalizeCancelReason(cancelReason) === 'OFFER_EXPIRED'
}

function isPermanentDecline(cancelReason) {
  return RIDER_DECLINE_REASONS.has(normalizeCancelReason(cancelReason))
}

function normalizeCancelReason(value) {
  return `${value || ''}`
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase()
}

function parseAddress(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (_) {
      return { address: value }
    }
  }
  if (typeof value === 'object') return value
  return {}
}

function resolveAddressText(address) {
  if (!address || typeof address !== 'object') {
    return 'Delivery address unavailable'
  }

  const direct = firstNonEmptyString(
    address.address,
    address.fullAddress,
    address.full_address,
    address.formattedAddress,
    address.formatted_address,
    address.addressLine1,
    address.address_line1,
    address.address_line_1,
    address.address_line
  )
  if (direct) return direct

  const parts = [
    firstNonEmptyString(address.addressLine1, address.address_line1, address.address_line_1, address.address_line),
    firstNonEmptyString(address.addressLine2, address.address_line2, address.address_line_2),
    firstNonEmptyString(address.area),
    firstNonEmptyString(address.city),
    firstNonEmptyString(address.state),
    firstNonEmptyString(address.pincode, address.postalCode, address.postal_code),
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(', ') : 'Delivery address unavailable'
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${value}`
    }
  }
  return ''
}

function parseItems(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch (_) {
      return []
    }
  }
  return []
}

function toNumber(value, fallback = Number.NaN) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function resolveRiderEarning(value, fallback = DEFAULT_RIDER_EARNING) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }

  const fallbackParsed = Number(fallback)
  if (Number.isFinite(fallbackParsed) && fallbackParsed > 0) {
    return fallbackParsed
  }

  return DEFAULT_RIDER_EARNING
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
