import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import { env } from '../config/env.js'
import { redis } from '../config/redis.js'

/**
 * Default rate-limit key: the real client IP (behind Cloudflare / nginx).
 */
export function clientIpKey(request) {
  const cfConnectingIp = request.headers['cf-connecting-ip']
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim()
  }

  const xRealIp = request.headers['x-real-ip']
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return xRealIp.trim()
  }

  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }

  return request.ip
}

/**
 * Redis-backed rate limiting for routes that opt in via `config.rateLimit`.
 */
async function rateLimitPlugin(fastify) {
  if (!env.RATE_LIMIT_ENABLED) {
    fastify.log.warn('Rate limiting is disabled by configuration')
    return
  }

  await fastify.register(rateLimit, {
    global: false,
    redis,
    hook: 'onRequest',
    nameSpace: 'bakaloo:ratelimit:',
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    skipOnError: true,
    keyGenerator: clientIpKey,
  })
}

export default fp(rateLimitPlugin, { name: 'rate-limit' })
