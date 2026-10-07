/**
 * Device Session Management Infrastructure for Meet Commerce Platform
 * Source of truth: Blueprint §05.1, §09.2, ADR-001
 *
 * ARCHITECTURAL CONSTRAINTS:
 *   1. Depends ONLY on core layers: database query/pool, logger, crypto, error constants.
 *   2. MUST NOT import or depend directly on domain modules (orders, products, inventory,
 *      payments, notifications, sockets, workers).
 *
 * @module utils/session
 */

import crypto from 'node:crypto'
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'

/**
 * Generate fingerprint hash from IP and User-Agent
 * @param {string} ip
 * @param {string} userAgent
 * @returns {string}
 */
export function generateDeviceFingerprint(ip, userAgent) {
  const raw = `${ip || '0.0.0.0'}:${userAgent || 'unknown'}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * Classify device type from User-Agent string
 * @param {string} userAgent
 * @returns {'MOBILE_APP' | 'WEB_DASHBOARD' | 'TABLET' | 'UNKNOWN'}
 */
export function classifyDeviceType(userAgent) {
  if (!userAgent) return 'UNKNOWN'
  const ua = String(userAgent).toLowerCase()
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone') || ua.includes('flutter')) {
    return 'MOBILE_APP'
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'TABLET'
  }
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari') || ua.includes('edge')) {
    return 'WEB_DASHBOARD'
  }
  return 'UNKNOWN'
}

/**
 * Register new active device session upon successful authentication
 * @param {object} args
 * @param {string} args.userId
 * @param {number} [args.sessionVersion=1]
 * @param {import('fastify').FastifyRequest} args.req
 * @param {number} [args.ttlDays=30]
 * @returns {Promise<{ sessionId: string, deviceFingerprint: string, expiresAt: Date }>}
 */
export async function createDeviceSession({ userId, sessionVersion = 1, req, ttlDays = 30 }) {
  const ip = req?.ip || req?.headers?.['x-forwarded-for'] || '127.0.0.1'
  const userAgent = req?.headers?.['user-agent'] || 'unknown'
  const fingerprint = generateDeviceFingerprint(ip, userAgent)
  const deviceType = classifyDeviceType(userAgent)
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)

  const { rows } = await query(
    `INSERT INTO user_device_sessions (
       user_id, session_version, device_fingerprint, ip_address, user_agent, device_type, is_revoked, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, false, $7)
     RETURNING id, device_fingerprint, expires_at`,
    [userId, sessionVersion, fingerprint, ip, userAgent, deviceType, expiresAt]
  )

  const session = rows[0]
  logger.info({ userId, sessionId: session.id, deviceType }, 'Device session created successfully')
  return {
    sessionId: session.id,
    deviceFingerprint: session.device_fingerprint,
    expiresAt: session.expires_at,
  }
}

/**
 * Check whether a device session is active and not revoked
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
export async function isSessionActive(sessionId) {
  if (!sessionId) return false
  const { rows } = await query(
    `SELECT id FROM user_device_sessions
      WHERE id = $1 AND is_revoked = false AND expires_at > NOW()
      LIMIT 1`,
    [sessionId]
  )
  return rows.length > 0
}

/**
 * List active device sessions for a user
 * @param {string} userId
 * @returns {Promise<Array<{ id: string, ipAddress: string, userAgent: string, deviceType: string, lastActiveAt: Date, isCurrent: boolean }>>}
 */
export async function listActiveSessions(userId, currentSessionId = null) {
  const { rows } = await query(
    `SELECT id, ip_address, user_agent, device_type, last_active_at, created_at, expires_at
       FROM user_device_sessions
      WHERE user_id = $1 AND is_revoked = false AND expires_at > NOW()
      ORDER BY last_active_at DESC`,
    [userId]
  )

  return rows.map((r) => ({
    id: r.id,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    deviceType: r.device_type,
    lastActiveAt: r.last_active_at || r.created_at,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    isCurrent: currentSessionId ? r.id === currentSessionId : false,
  }))
}

/**
 * Revoke specific device session
 * @param {string} sessionId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function revokeSession(sessionId, userId) {
  const { rowCount } = await query(
    `UPDATE user_device_sessions
        SET is_revoked = true
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  )
  return rowCount > 0
}

/**
 * Revoke all other device sessions for user EXCEPT current session
 * @param {string} currentSessionId
 * @param {string} userId
 * @returns {Promise<number>} Number of revoked sessions
 */
export async function revokeAllOtherSessions(currentSessionId, userId) {
  const { rowCount } = await query(
    `UPDATE user_device_sessions
        SET is_revoked = true
      WHERE user_id = $1 AND id != $2 AND is_revoked = false`,
    [userId, currentSessionId]
  )
  return rowCount
}

/**
 * Revoke ALL device sessions for user and increment session_version in users table
 * @param {string} userId
 * @returns {Promise<number>} New session_version integer
 */
export async function revokeAllUserSessions(userId) {
  await query(
    `UPDATE user_device_sessions
        SET is_revoked = true
      WHERE user_id = $1 AND is_revoked = false`,
    [userId]
  )

  const { rows } = await query(
    `UPDATE users
        SET session_version = COALESCE(session_version, 1) + 1
      WHERE id = $1
      RETURNING session_version`,
    [userId]
  )

  return rows[0]?.session_version || 1
}
