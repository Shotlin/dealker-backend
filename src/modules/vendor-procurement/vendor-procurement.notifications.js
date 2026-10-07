/**
 * Procurement Notifier — event notifications for the vendor procurement flow
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §19
 *
 * Reuses the existing notifications stack (in-app insert + Socket.IO emit +
 * FCM push via NotificationsService). All dispatch is fire-and-forget: a
 * notification or push failure must never fail the procurement action that
 * triggered it (blueprint §19 — token failure does not break the transaction).
 *
 * @module modules/vendor-procurement/vendor-procurement.notifications
 */

import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

export class ProcurementNotifier {
  /**
   * @param {import('../../fastify').FastifyInstance | null} fastify - needed for Socket.IO emit
   */
  constructor(fastify = null) {
    this.fastify = fastify
    this.notifications = fastify ? new NotificationsService(new NotificationsRepository(), fastify) : null
  }

  /**
   * Active vendor-user ids for the given vendors (recipients of in-app + push).
   */
  async resolveVendorUserIds(vendorIds) {
    if (!vendorIds || vendorIds.length === 0) return []
    const { rows } = await query(
      `SELECT DISTINCT vu.user_id
         FROM vendor_users vu
        WHERE vu.vendor_id = ANY($1::uuid[])
          AND vu.is_active
          AND vu.deleted_at IS NULL`,
      [vendorIds]
    )
    return rows.map((row) => row.user_id)
  }

  /**
   * Sends to user ids after the triggering transaction has committed.
   * Never throws — errors are logged (fire-and-forget contract).
   */
  async dispatch(userIds, { title, body, type = 'procurement', data = {}, channelId, sound, app }) {
    if (!userIds || userIds.length === 0) return
    try {
      await Promise.allSettled(
        userIds.map((userId) =>
          this.notifications
            ? this.notifications.sendNotification(userId, { title, body, type, data, channelId, sound, app })
            : Promise.resolve()
        )
      )
    } catch (err) {
      logger.error({ err, userIds }, 'Procurement notification dispatch failed')
    }
  }

  notifyUsers(userIds, payload) {
    if (!userIds || userIds.length === 0) return
    setImmediate(() => {
      this.dispatch(userIds, payload).catch(() => {})
    })
  }

  async notifyVendorUsers(vendorIds, payload) {
    try {
      const userIds = await this.resolveVendorUserIds(vendorIds)
      // Vendor-facing: push goes to the vendor app only, never the same
      // person's customer app.
      this.notifyUsers(userIds, { ...payload, app: 'vendor' })
    } catch (err) {
      logger.error({ err, vendorIds }, 'Resolving vendor users for notification failed')
    }
  }

  // ── Event payloads (blueprint §19 wording) ─────────────────────

  requestPublished(recipients, { requestId, requestNumber, shopName, requiredDeliveryAt, mode }) {
    this.notifyVendorUsers(
      recipients.map((r) => r.vendor_id),
      {
        title: 'New procurement requirement',
        body: `${shopName || 'A FreshCuts store'} published ${requestNumber} — respond before the deadline.`,
        data: { event: 'request_published', request_id: requestId, request_number: requestNumber, mode },
        // A new requirement is the one event the vendor app rings a loud,
        // looping in-app alert for while running (ProcurementAlertListener)
        // — this makes the same event equally hard to miss via a real push
        // when the app is fully closed, using the vendor app's own
        // Android notification channel (created client-side, §the vendor
        // app's PushNotificationService) instead of the shared generic
        // 'bakaloo_notifications' channel every other notification type
        // still uses by default.
        channelId: 'procurement_alerts',
        sound: 'new_requirement_alert',
      }
    )
  }

  requestClosed(recipients, { requestId, requestNumber, status }) {
    this.notifyVendorUsers(
      recipients.map((r) => r.vendor_id),
      {
        title: status === 'CANCELLED' ? 'Requirement cancelled' : 'Requirement closed',
        body: `${requestNumber} is no longer open for responses.`,
        data: { event: `request_${status.toLowerCase()}`, request_id: requestId, request_number: requestNumber },
      }
    )
  }

  offerAwarded(vendorId, { requestId, requestNumber, supplyNumber, awardTotal }) {
    this.notifyVendorUsers([vendorId], {
      title: 'Offer accepted — supply order created',
      body: `You won ${requestNumber}. Supply order ${supplyNumber} is now active.`,
      data: { event: 'offer_awarded', request_id: requestId, supply_order_number: supplyNumber, award_total: awardTotal },
    })
  }

  quoteSubmittedToStore(createdBy, { requestId, requestNumber, vendorName, grandTotal }) {
    this.notifyUsers(createdBy ? [createdBy] : [], {
      title: 'New quotation received',
      body: `${vendorName || 'A vendor'} quoted on ${requestNumber}.`,
      data: { event: 'quote_submitted', request_id: requestId, request_number: requestNumber, grand_total: grandTotal },
    })
  }

  offerAcceptedByVendor(createdBy, { requestId, requestNumber, supplyNumber }) {
    this.notifyUsers(createdBy ? [createdBy] : [], {
      title: 'Fixed offer accepted',
      body: `${requestNumber} was accepted. Supply order ${supplyNumber} is now active.`,
      data: { event: 'offer_accepted', request_id: requestId, supply_order_number: supplyNumber },
    })
  }

  rfqAwarded(winnerVendorId, loserVendorIds, { requestId, requestNumber, supplyNumber }) {
    this.notifyVendorUsers([winnerVendorId], {
      title: 'Your quote was selected',
      body: `You won ${requestNumber}. Supply order ${supplyNumber} is now active.`,
      data: { event: 'rfq_awarded', request_id: requestId, supply_order_number: supplyNumber },
    })
    this.notifyVendorUsers(loserVendorIds, {
      title: 'Requirement awarded to another vendor',
      body: `${requestNumber} was awarded to a different vendor. Better luck next time.`,
      data: { event: 'rfq_not_selected', request_id: requestId, request_number: requestNumber },
    })
  }
}
