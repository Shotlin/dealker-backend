import { redis } from '../config/redis.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Get a cached value (auto JSON parse)
 * @param {string} key
 * @returns {Promise<*|null>}
 */
export async function cacheGet(key) {
  try {
    const data = await redis.get(key)
    if (!data) return null
    try {
      return JSON.parse(data)
    } catch {
      return data
    }
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Redis cacheGet error, falling back')
    return null
  }
}

/**
 * Set a cache value (auto JSON stringify)
 * @param {string} key
 * @param {*} value
 * @param {number} ttl - Time to live in seconds (default from env)
 */
export async function cacheSet(key, value, ttl = env.REDIS_TTL_DEFAULT) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    if (ttl) {
      await redis.set(key, serialized, 'EX', ttl)
    } else {
      await redis.set(key, serialized)
    }
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Redis cacheSet error')
  }
}

/**
 * Delete a single cache key
 * @param {string} key
 */
export async function cacheDel(key) {
  try {
    await redis.del(key)
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Redis cacheDel error')
  }
}

/**
 * Delete all keys matching a pattern using SCAN (non-blocking)
 * @param {string} pattern - e.g. 'products:list:*'
 */
export async function cacheDeletePattern(pattern) {
  try {
    let cursor = '0'
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = nextCursor
      if (keys.length > 0) {
        await redis.del(...keys)
      }
    } while (cursor !== '0')
  } catch (err) {
    logger.warn({ err: err.message, pattern }, 'Redis cacheDeletePattern error')
  }
}
