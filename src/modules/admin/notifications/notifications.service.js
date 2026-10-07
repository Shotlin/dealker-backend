import { AdminNotificationsRepository } from './notifications.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { logger } from '../../../config/logger.js'
import { sendPushBatch } from '../../../utils/pushNotification.js'

const repo = new AdminNotificationsRepository()

export class AdminNotificationsService {
  /* ── Templates ── */

  async listTemplates() {
    return repo.findAllTemplates()
  }

  async getTemplate(id) {
    return repo.findTemplateById(id)
  }

  async createTemplate(data, adminId, ip) {
    const t = await repo.createTemplate(data)
    logAdminActivity(adminId, 'CREATE_TEMPLATE', 'notification_template', t.id, null, null, ip)
    return t
  }

  async updateTemplate(id, data, adminId, ip) {
    const t = await repo.updateTemplate(id, data)
    if (t) {
      logAdminActivity(adminId, 'UPDATE_TEMPLATE', 'notification_template', id, null, null, ip)
    }
    return t
  }

  async deleteTemplate(id, adminId, ip) {
    const ok = await repo.deleteTemplate(id)
    if (ok) {
      logAdminActivity(adminId, 'DELETE_TEMPLATE', 'notification_template', id, null, null, ip)
    }
    return ok
  }

  /* ── Campaigns ── */

  async sendBulk({ title, body, segment, segmentValue, segmentFilters, image_url, deep_link, type, expires_at, template_id, target_phones }, adminId, ip) {
    // Pre-count targets
    const targetCount = await repo.getSegmentCount(segment, segmentValue)

    const campaign = await repo.createCampaign({
      title, body, type, segment, segmentValue,
      image_url, deep_link, expires_at, template_id,
      scheduledAt: null, createdBy: adminId, targetCount,
    })

    // Execute send asynchronously so API responds immediately
    this._executeSend(campaign.id, { title, body, segment, segmentValue, image_url, deep_link, type, expires_at }, adminId)
      .catch(err => logger.error({ err, campaignId: campaign.id }, 'Async campaign send failed'))

    logAdminActivity(adminId, 'SEND_BULK_NOTIFICATION', 'notification_campaign', campaign.id, null, { segment, targetCount }, ip)
    return { ...campaign, target_count: targetCount }
  }

  async scheduleCampaign({ title, body, segment, segmentValue, segmentFilters, scheduledAt, image_url, deep_link, type, expires_at, template_id }, adminId, ip) {
    const targetCount = await repo.getSegmentCount(segment, segmentValue)

    const campaign = await repo.createCampaign({
      title, body, type, segment, segmentValue,
      image_url, deep_link, expires_at, template_id,
      scheduledAt, createdBy: adminId, targetCount,
    })

    logAdminActivity(adminId, 'SCHEDULE_CAMPAIGN', 'notification_campaign', campaign.id, null, { scheduledAt, targetCount }, ip)
    return campaign
  }

  async cancelCampaign(id, adminId, ip) {
    const c = await repo.cancelCampaign(id)
    if (c) {
      logAdminActivity(adminId, 'CANCEL_CAMPAIGN', 'notification_campaign', id, null, null, ip)
    }
    return c
  }

  async listCampaigns({ page = 1, limit = 20, status }) {
    const offset = (page - 1) * limit
    return repo.findAllCampaigns({ offset, limit, status })
  }

  async getCampaign(id) {
    return repo.findCampaignById(id)
  }

  async getSegmentCount(segment, segmentValue) {
    return repo.getSegmentCount(segment, segmentValue)
  }

  /**
   * Core send executor — called for both immediate and scheduled campaigns.
   * Handles batch FCM, deactivates invalid tokens, updates campaign status.
   */
  async _executeSend(campaignId, { title, body, segment, segmentValue, image_url, deep_link, type, expires_at }) {
    const notificationData = {
      type: type || 'CAMPAIGN',
      campaignId,
      deepLink: deep_link || '',
      expiresAt: expires_at || '',
      imageUrl: image_url || '',
    }

    // Save to every targeted user's in-app Notification tab first, before
    // attempting push at all — guarantees the message is visible there
    // even for a user whose device never got a valid push token (see
    // repository doc comment). Best-effort: a failure here must not skip
    // the push attempt below.
    const allTargetUserIds = await repo.getTargetUserIds(segment, segmentValue)
    // Vendor campaigns are push-only: the vendor app has no notification
    // inbox, and a vendor who is also a customer (same phone) must not see
    // a vendor announcement in their customer Notification tab.
    const isVendorSegment = segment === 'all_vendors' || segment === 'specific_vendor'
    if (allTargetUserIds.length > 0 && !isVendorSegment) {
      try {
        await repo.createBulkNotifications(allTargetUserIds, {
          title, body, type: type || 'general', data: notificationData, campaignId,
        })
      } catch (err) {
        logger.error({ err, campaignId }, 'Bulk in-app notification creation failed')
      }
    }

    const targets = await repo.getTargetUsersWithTokens(segment, segmentValue)
    if (!targets.length) {
      await repo.updateCampaignStatus(campaignId, 'SENT', {
        sentCount: 0,
        failedCount: 0,
        failureSummary: allTargetUserIds.length > 0
          ? {
              reason: isVendorSegment
                ? `${allTargetUserIds.length} vendor user(s) matched, but none has the vendor app signed in with push enabled — nothing was sent.`
                : `Delivered in-app to ${allTargetUserIds.length} user(s) — none had an active push token, so no push notification was sent.`,
            }
          : undefined,
      })
      return
    }

    const tokens = targets.map(t => t.fcm_token)
    const result = await sendPushBatch(tokens, {
      title,
      body,
      imageUrl: image_url,
      deepLink: deep_link,
      data: notificationData,
    })

    // Deactivate invalid tokens
    if (result.invalidTokens?.length > 0) {
      await repo.deactivateInvalidTokens(result.invalidTokens)
      logger.info({ count: result.invalidTokens.length, campaignId }, 'Deactivated invalid FCM tokens')
    }

    const failureSummary = result.success
      ? { invalidTokensDeactivated: result.invalidTokens?.length || 0 }
      : { reason: result.reason }

    await repo.updateCampaignStatus(campaignId, result.success ? 'SENT' : 'FAILED', {
      sentCount: result.sent || 0,
      failedCount: result.failed || 0,
      failureSummary,
    })

    logger.info({ campaignId, sent: result.sent, failed: result.failed }, 'Campaign send complete')
  }

  /**
   * Called by the scheduled campaign poller worker.
   */
  async executeScheduledCampaign(campaignId, campaignData) {
    return this._executeSend(campaignId, campaignData)
  }
}
