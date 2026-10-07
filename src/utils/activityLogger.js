import { query } from '../config/database.js'
import { logger } from '../config/logger.js'

/**
 * Log an admin action to admin_activity_log (fire-and-forget)
 * Never throws — errors are silently logged
 *
 * @param {string} adminId - UUID of admin user
 * @param {string} action - Human-readable action description
 * @param {string} entityType - 'product', 'order', 'user', 'rider', 'banner', etc.
 * @param {string|null} entityId - UUID of the entity (nullable)
 * @param {object|null} oldValue - Previous value (JSONB)
 * @param {object|null} newValue - New value (JSONB)
 * @param {string|null} ipAddress - Client IP address
 */
export function logAdminActivity(adminId, action, entityType, entityId = null, oldValue = null, newValue = null, ipAddress = null) {
  setImmediate(async () => {
    try {
      await query(
        `INSERT INTO admin_activity_log (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          adminId,
          action,
          entityType,
          entityId,
          oldValue ? JSON.stringify(oldValue) : null,
          newValue ? JSON.stringify(newValue) : null,
          ipAddress,
        ]
      )
    } catch (err) {
      logger.error({ err, adminId, action, entityType }, 'Failed to log admin activity')
    }
  })
}
