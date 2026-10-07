import Redis from 'ioredis'
import { env } from './env.js'
import { logger } from './logger.js'

const redisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,      // Required for BullMQ
  retryStrategy: (times) => {
    if (times > 10) return null    // Stop retrying after 10 attempts
    return Math.min(times * 200, 5000)
  },
}

if (env.REDIS_PASSWORD) {
  redisOptions.password = env.REDIS_PASSWORD
}

export const redis = new Redis(redisOptions)

redis.on('connect', () => {
  logger.info('✅ Redis connected successfully')
})

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error')
})

redis.on('close', () => {
  logger.warn('Redis connection closed')
})

/**
 * Close Redis connection (for graceful shutdown)
 */
export const closeRedis = () => redis.quit()
