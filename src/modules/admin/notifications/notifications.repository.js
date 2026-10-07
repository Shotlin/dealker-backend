import { query, getClient } from '../../../config/database.js'

const TEMPLATE_COLS = `
  id, name, title, body, type, variables, image_url, deep_link,
  is_active, created_by, created_at, updated_at
`

const CAMPAIGN_COLS = `
  nc.id, nc.title, nc.body, nc.image_url, nc.deep_link, nc.type,
  nc.target_type, nc.segment, nc.target_count, nc.sent_count,
  (SELECT COUNT(*)::int FROM notifications n
    WHERE n.campaign_id = nc.id AND n.is_read = true) AS opened_count,
  nc.failed_count, nc.failure_summary,
  nc.status, nc.template_id, nc.scheduled_at, nc.expires_at,
  nc.sent_at, nc.created_by, nc.created_at, nc.updated_at,
  u.name AS created_by_name
`

export class AdminNotificationsRepository {
  /* ── Templates ── */

  async findAllTemplates() {
    const { rows } = await query(
      `SELECT ${TEMPLATE_COLS} FROM notification_templates ORDER BY name`
    )
    return rows
  }

  async findTemplateById(id) {
    const { rows: [t] } = await query(
      `SELECT ${TEMPLATE_COLS} FROM notification_templates WHERE id = $1`,
      [id]
    )
    return t || null
  }

  async createTemplate({ name, title, body, type = 'PUSH', variables, image_url, deep_link }) {
    const { rows: [t] } = await query(
      `INSERT INTO notification_templates
         (name, title, body, type, variables, image_url, deep_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${TEMPLATE_COLS}`,
      [name, title, body, type, JSON.stringify(variables || []), image_url || null, deep_link || null]
    )
    return t
  }

  async updateTemplate(id, updates) {
    const allowed = ['name', 'title', 'body', 'type', 'variables', 'image_url', 'deep_link', 'is_active']
    const sets = []; const params = []; let idx = 1
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx++}`)
        params.push(key === 'variables' ? JSON.stringify(updates[key]) : updates[key])
      }
    }
    if (sets.length === 0) return this.findTemplateById(id)
    sets.push(`updated_at = NOW()`)
    params.push(id)
    const { rows: [t] } = await query(
      `UPDATE notification_templates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${TEMPLATE_COLS}`,
      params
    )
    return t || null
  }

  async deleteTemplate(id) {
    const { rowCount } = await query(
      'DELETE FROM notification_templates WHERE id = $1',
      [id]
    )
    return rowCount > 0
  }

  /* ── Campaigns ── */

  async createCampaign({ title, body, type, segment, segmentValue, image_url, deep_link, expires_at, template_id, scheduledAt, createdBy, targetCount = 0 }) {
    // Map canonical segment names to DB target_type CHECK constraint values
    const segmentToTargetType = {
      all_customers: 'all_customers',
      specific_user: 'custom_list',
      store_customers: 'all_customers',
      inactive_customers: 'no_order_30_days',
      cart_not_empty: 'wishlist_users',
      all: 'all_customers',
      new: 'all_customers',
      inactive: 'no_order_30_days',
      high_value: 'high_value',
    }
    const targetType = segmentToTargetType[segment] || 'all_customers'
    const status = scheduledAt ? 'SCHEDULED' : 'SENDING'

    const { rows: [c] } = await query(
      `INSERT INTO notification_campaigns
         (title, body, type, target_type, segment, image_url, deep_link,
          expires_at, template_id, target_count, scheduled_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, title, body, type, target_type, segment, image_url, deep_link,
         expires_at, template_id, target_count, sent_count, failed_count,
         status, scheduled_at, created_by, created_at`,
      [
        title, body, type || 'general', targetType, segment,
        image_url || null, deep_link || null,
        expires_at || null, template_id || null,
        targetCount, scheduledAt || null, status, createdBy,
      ]
    )
    return c
  }

  async findAllCampaigns({ offset, limit, status }) {
    const params = [limit, offset]
    let where = ''
    if (status) {
      where = 'WHERE nc.status = $3'
      params.push(status)
    }
    const { rows } = await query(
      `SELECT ${CAMPAIGN_COLS}
       FROM notification_campaigns nc
       LEFT JOIN users u ON u.id = nc.created_by
       ${where}
       ORDER BY nc.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    )
    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM notification_campaigns ${where}`,
      status ? [status] : []
    )
    return { campaigns: rows, total: countRes.rows[0].total }
  }

  async findCampaignById(id) {
    const { rows: [c] } = await query(
      `SELECT ${CAMPAIGN_COLS}
       FROM notification_campaigns nc
       LEFT JOIN users u ON u.id = nc.created_by
       WHERE nc.id = $1`,
      [id]
    )
    return c || null
  }

  async findDueScheduledCampaigns() {
    const { rows } = await query(
      `SELECT id, title, body, type, segment, image_url, deep_link, expires_at, template_id
       FROM notification_campaigns
       WHERE status = 'SCHEDULED' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 20`
    )
    return rows
  }

  async lockAndMarkSending(id) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id FROM notification_campaigns WHERE id = $1 AND status = 'SCHEDULED' FOR UPDATE SKIP LOCKED`,
        [id]
      )
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `UPDATE notification_campaigns SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
        [id]
      )
      await client.query('COMMIT')
      return true
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async updateCampaignStatus(id, status, { sentCount, failedCount, failureSummary } = {}) {
    const sets = ['status = $1', 'updated_at = NOW()']
    const params = [status]
    let idx = 2

    if (sentCount !== undefined) {
      sets.push(`sent_count = $${idx++}`)
      params.push(sentCount)
    }
    if (failedCount !== undefined) {
      sets.push(`failed_count = $${idx++}`)
      params.push(failedCount)
    }
    if (failureSummary !== undefined) {
      sets.push(`failure_summary = $${idx++}`)
      params.push(JSON.stringify(failureSummary))
    }
    if (status === 'SENT') {
      sets.push('sent_at = NOW()')
    }
    params.push(id)
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, status, sent_count, failed_count`,
      params
    )
    return c
  }

  async cancelCampaign(id) {
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND status = 'SCHEDULED'
       RETURNING id, status`,
      [id]
    )
    return c || null
  }

  /* ── Segment Queries ── */

  // Deliberately NOT joined to fcm_tokens — this counts everyone the
  // targeting criteria actually matches, which is what "X users in
  // segment" honestly means to an admin. Previously this required an
  // active push token to even be counted, so a "Specific User" target
  // whose device had no valid token (missing permission, no push key
  // configured, app not opened recently) showed "0 users in segment" —
  // confusing and indistinguishable from "no such user."
  async getSegmentCount(segment, segmentValue) {
    const { where, params } = buildSegmentWhere(segment, segmentValue)
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(DISTINCT u.id)::int AS count
       FROM users u
       WHERE ${where}`,
      params
    )
    return count
  }

  /** Every matching user, regardless of whether they have a push token — used to guarantee the in-app notification fallback for the full target audience. */
  async getTargetUserIds(segment, segmentValue) {
    const { where, params } = buildSegmentWhere(segment, segmentValue)
    const { rows } = await query(
      `SELECT DISTINCT u.id AS user_id FROM users u WHERE ${where}`,
      params
    )
    return rows.map((r) => r.user_id)
  }

  // Only the tokens of the app this segment is for — a customer segment
  // never pushes to the vendor app (even when the same person is signed
  // into both), and a vendor segment never pushes to the customer app.
  async getTargetUsersWithTokens(segment, segmentValue) {
    const { where, params } = buildSegmentWhere(segment, segmentValue)
    params.push(appForSegment(segment))
    const { rows } = await query(
      `SELECT DISTINCT ON (u.id) u.id AS user_id, ft.token AS fcm_token
       FROM users u
       INNER JOIN fcm_tokens ft ON ft.user_id = u.id AND ft.is_active = true
         AND ft.app = $${params.length}
       WHERE ${where}
       ORDER BY u.id`,
      params
    )
    return rows
  }

  /**
   * Save the campaign notification into every targeted user's in-app
   * Notification tab — independent of push delivery. This is the guarantee
   * that a customer never gets literally nothing when an admin sends them
   * a notification, even if their device's push token is missing/invalid/
   * revoked (previously campaigns were push-only with no such fallback,
   * unlike the single-user NotificationsService.sendNotification() path
   * used by orders/wallet/abandoned-cart, which always wrote this row).
   */
  async createBulkNotifications(userIds, { title, body, type, data, campaignId }) {
    if (!userIds?.length) return
    await query(
      `INSERT INTO notifications (user_id, title, body, type, data, campaign_id)
       SELECT unnest($1::uuid[]), $2, $3, $4, $5::jsonb, $6`,
      [userIds, title, body, type || 'general', JSON.stringify(data || {}), campaignId || null]
    )
  }

  async deactivateInvalidTokens(tokens) {
    if (!tokens?.length) return
    await query(
      `UPDATE fcm_tokens SET is_active = false WHERE token = ANY($1)`,
      [tokens]
    )
  }
}

export const VENDOR_SEGMENTS = ['all_vendors', 'specific_vendor']

/** Which app's push tokens a segment is delivered to. */
export function appForSegment(segment) {
  return VENDOR_SEGMENTS.includes(segment) ? 'vendor' : 'customer'
}

function buildSegmentWhere(segment, segmentValue) {
  const customerBaseWhere = "u.role = 'CUSTOMER' AND u.is_active = true"
  const vendorBaseWhere = `u.is_active = true AND u.id IN (
    SELECT vu.user_id FROM vendor_users vu
    JOIN vendors v ON v.id = vu.vendor_id
    WHERE vu.is_active = true AND vu.deleted_at IS NULL
      AND v.is_active = true AND v.deleted_at IS NULL
  )`
  const params = []

  switch (segment) {
    case 'all_vendors':
      return { where: vendorBaseWhere, params }

    case 'specific_vendor': {
      // segmentValue = a vendor id, or the phone number of one of that
      // vendor's users. No value → matches nobody (never "every vendor").
      if (!segmentValue) return { where: 'FALSE', params }
      params.push(segmentValue)
      return {
        where: `${vendorBaseWhere} AND (
          u.id IN (SELECT vu.user_id FROM vendor_users vu WHERE vu.vendor_id::text = $${params.length})
          OR u.phone = $${params.length}
        )`,
        params,
      }
    }

    case 'all_customers':
    case 'all':
      return { where: customerBaseWhere, params }

    case 'new':
      return {
        where: `${customerBaseWhere} AND u.created_at >= NOW() - INTERVAL '30 days'`,
        params,
      }

    case 'inactive_customers':
    case 'inactive':
      return {
        where: `${customerBaseWhere} AND u.id NOT IN (
          SELECT DISTINCT customer_id FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'
        )`,
        params,
      }

    case 'high_value':
      return {
        where: `${customerBaseWhere} AND u.id IN (
          SELECT customer_id FROM orders WHERE status = 'DELIVERED'
          GROUP BY customer_id HAVING SUM(total_payable) >= 5000
        )`,
        params,
      }

    case 'specific_user': {
      // Target a specific person by phone or user ID — no role restriction so
      // admins can test notifications with their own accounts.
      const baseWhere = "u.is_active = true"
      if (segmentValue) {
        params.push(segmentValue)
        return {
          where: `${baseWhere} AND (u.id::text = $${params.length} OR u.phone = $${params.length})`,
          params,
        }
      }
      return { where: baseWhere, params }
    }

    case 'store_customers': {
      if (segmentValue) {
        params.push(segmentValue)
        return {
          where: `${customerBaseWhere} AND u.id IN (
            SELECT DISTINCT customer_id FROM orders WHERE shop_id = $${params.length}
          )`,
          params,
        }
      }
      return { where: customerBaseWhere, params }
    }

    case 'cart_not_empty':
      return {
        where: `${customerBaseWhere} AND u.id IN (
          SELECT DISTINCT user_id FROM cart_items
        )`,
        params,
      }

    case 'custom_segment': {
      // Admin-defined customer segment (see customer_segments/customer_segment_members).
      if (segmentValue) {
        params.push(segmentValue)
        return {
          where: `${customerBaseWhere} AND u.id IN (
            SELECT user_id FROM customer_segment_members WHERE segment_id = $${params.length}
          )`,
          params,
        }
      }
      return { where: customerBaseWhere, params }
    }

    default:
      return { where: customerBaseWhere, params }
  }
}
