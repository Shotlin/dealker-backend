/**
 * Generic Idempotency Middleware Infrastructure for Meet Commerce Platform
 * Source of truth: Blueprint §04.3, ADR-001
 *
 * ARCHITECTURAL CONSTRAINT:
 * This module MUST NOT import or depend on any business domain modules
 * (orders, vendors, warehouses, products). It depends strictly on core
 * infrastructure (database pool, logger, crypto, error constants).
 *
 * Behavior:
 *   1. Missing header: Passes through (or throws 400 IDEMPOTENCY_KEY_REQUIRED if required: true).
 *   2. Same key + Same request payload hash (SHA-256): Returns cached HTTP snapshot (COMPLETE status).
 *   3. Same key + Different request payload hash: Throws HTTP 409 IDEMPOTENCY_KEY_REUSED (STATE_CONFLICT).
 *
 * @module utils/idempotency
 */

import crypto from 'node:crypto'
import { pool } from '../config/database.js'
import { logger } from '../config/logger.js'
import { ERROR_CODES, HTTP_STATUS } from '../constants/errors.js'

/**
 * Compute strict 64-char SHA-256 hex digest of request payload
 * @param {unknown} body
 * @returns {string}
 */
export function computeRequestHash(body) {
  const normalized = body ? JSON.stringify(body) : ''
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

/**
 * Factory function creating Fastify preHandler middleware for request idempotency
 * @param {object} [opts]
 * @param {boolean} [opts.required=false] Whether X-Idempotency-Key header is mandatory
 * @param {number} [opts.ttlSeconds=86400] Key expiration TTL in seconds (default 24h)
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireIdempotency(opts = {}) {
  const isRequired = opts.required ?? false
  const ttlSeconds = opts.ttlSeconds ?? 86400

  return async function idempotencyMiddleware(request, reply) {
    const key = request.headers['x-idempotency-key']

    if (!key) {
      if (isRequired) {
        return reply.status(HTTP_STATUS[ERROR_CODES.VALIDATION_ERROR]).send({
          success: false,
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'X-Idempotency-Key header is required for this endpoint',
        })
      }
      return // Non-mandatory endpoint without key passes through
    }

    const userId = request.user?.id
    if (!userId) {
      // Idempotency scoping requires authenticated user context
      return reply.status(HTTP_STATUS[ERROR_CODES.UNAUTHORIZED]).send({
        success: false,
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Authentication required to process idempotency key',
      })
    }

    const requestHash = computeRequestHash(request.body)
    const client = await pool.connect()

    try {
      // 1. Lookup existing idempotency record
      const existingRes = await client.query(
        `SELECT id, request_hash, status, response_snapshot, expires_at
         FROM idempotency_keys
         WHERE key = $1 AND user_id = $2
         FOR UPDATE`,
        [key, userId]
      )

      if (existingRes.rows.length > 0) {
        const record = existingRes.rows[0]

        // Check payload hash match
        if (record.request_hash !== requestHash) {
          logger.warn(
            { key, userId, expected: record.request_hash, actual: requestHash },
            'Idempotency key payload mismatch detected — returning 409 CONFLICT'
          )
          return reply.status(409).send({
            success: false,
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key was previously used with a different request payload',
          })
        }

        // Return cached response if completed
        if (record.status === 'COMPLETE' && record.response_snapshot) {
          const snapshot = record.response_snapshot
          logger.info({ key, userId }, 'Returning cached idempotency response snapshot')
          return reply.status(snapshot.statusCode || 200).send(snapshot.body)
        }

        // Concurrent request processing in progress
        if (record.status === 'PROCESSING') {
          return reply.status(409).send({
            success: false,
            code: 'STATE_CONFLICT',
            message: 'A request with this idempotency key is currently being processed',
          })
        }
      }

      // 2. Insert new processing record
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
      await client.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, status, expires_at)
         VALUES ($1, $2, $3, 'PROCESSING', $4)
         ON CONFLICT (key, user_id) DO NOTHING`,
        [key, userId, requestHash, expiresAt]
      )

      // 3. Attach snapshot hook to response send
      reply.raw.on('finish', async () => {
        if (reply.statusCode >= 200 && reply.statusCode < 300) {
          try {
            const updateClient = await pool.connect()
            try {
              await updateClient.query(
                `UPDATE idempotency_keys
                 SET status = 'COMPLETE',
                     response_snapshot = $1
                 WHERE key = $2 AND user_id = $3`,
                [
                  JSON.stringify({
                    statusCode: reply.statusCode,
                    body: reply.sentPayload ? JSON.parse(reply.sentPayload) : null,
                  }),
                  key,
                  userId,
                ]
              )
            } finally {
              updateClient.release()
            }
          } catch (err) {
            logger.error({ err, key, userId }, 'Failed to persist idempotency response snapshot')
          }
        }
      })
    } finally {
      client.release()
    }
  }
}
