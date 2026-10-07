/**
 * Report caching utility.
 *
 * Provides cache-through helpers for report endpoints with:
 * - Key pattern: bakaloo:reports:{endpoint}:{hash_of_query}:{shopId|global}
 * - TTL: 300 seconds
 * - X-Report-Generated-At header on cached responses
 *
 * @module utils/report-cache
 */

import crypto from 'node:crypto'
import { cacheGet, cacheSet } from './cache.js'

const REPORT_CACHE_TTL = 300 // 5 minutes

/**
 * Generate a deterministic hash of query parameters for cache keying.
 *
 * @param {object} query - Query parameters object
 * @returns {string} MD5 hex hash
 */
function hashQuery(query) {
  const sorted = JSON.stringify(query, Object.keys(query).sort())
  return crypto.createHash('md5').update(sorted).digest('hex')
}

/**
 * Build a cache key for a report endpoint.
 *
 * @param {string} endpoint - Report endpoint name (e.g., 'gmv', 'orders')
 * @param {object} query - Query parameters
 * @param {string|null} shopId - Shop ID or null for global
 * @returns {string}
 */
export function buildReportCacheKey(endpoint, query, shopId) {
  const qHash = hashQuery(query)
  const scope = shopId || 'global'
  return `bakaloo:reports:${endpoint}:${qHash}:${scope}`
}

/**
 * Cache-through wrapper for report computation.
 *
 * If cached data exists, returns it with the generation timestamp.
 * Otherwise, executes the compute function, caches the result, and returns it.
 *
 * @param {object} options
 * @param {string} options.endpoint - Report endpoint name
 * @param {object} options.query - Query parameters
 * @param {string|null} options.shopId - Shop scope
 * @param {import('fastify').FastifyReply} options.reply - Fastify reply for header
 * @param {() => Promise<object>} options.compute - Function to compute report data
 * @returns {Promise<object>}
 */
export async function cachedReport({ endpoint, query, shopId, reply, compute }) {
  const cacheKey = buildReportCacheKey(endpoint, query, shopId)

  const cached = await cacheGet(cacheKey)
  if (cached) {
    const generatedAt = cached._generatedAt || new Date().toISOString()
    reply.header('X-Report-Generated-At', generatedAt)
    const { _generatedAt, ...data } = cached
    return data
  }

  const result = await compute()
  const generatedAt = new Date().toISOString()

  // Store with generation timestamp
  await cacheSet(cacheKey, { ...result, _generatedAt: generatedAt }, REPORT_CACHE_TTL)

  reply.header('X-Report-Generated-At', generatedAt)
  return result
}
