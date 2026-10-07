import fp from 'fastify-plugin'
import { env } from '../config/env.js'

/**
 * Global error handler plugin
 * Maps known errors to proper HTTP responses
 * Hides stack traces in production
 */
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const { statusCode = 500, message, validation, code } = error

    // Fastify validation errors (JSON Schema)
    if (validation) {
      return reply.code(400).send({
        success: false,
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        errors: validation.map((v) => ({
          field: v.instancePath?.replace('/', '') || v.params?.missingProperty,
          message: v.message,
        })),
      })
    }

    // Rate-limit errors — pass through with 429
    if (statusCode === 429 || code === 'FST_RATE_LIMIT_EXCEEDED') {
      return reply.code(429).send({
        success: false,
        message: message || 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
      })
    }

    // 401/403 from a *thrown* error (as opposed to an explicit
    // `reply.code(401).send(...)`, which never reaches this handler) is
    // trustworthy only when it's a genuine Fastify/plugin error — those
    // carry a `FST_`-prefixed `code` (e.g. the JWT plugin's expired/
    // invalid-token errors). Third-party SDKs (Razorpay, etc.) throw
    // errors whose `statusCode` mirrors THEIR API's response, not ours
    // — a Razorpay account misconfiguration returning 401 must not be
    // forwarded as if the customer's own session were invalid, or every
    // provider-side outage looks like "you're logged out" to the app.
    const isTrustedAuthStatus =
      (statusCode !== 401 && statusCode !== 403) ||
      (typeof code === 'string' && code.startsWith('FST_'))

    // Known HTTP errors
    if (statusCode < 500 && isTrustedAuthStatus) {
      return reply.code(statusCode).send({
        success: false,
        message,
        code: code || 'ERROR',
      })
    }

    if (statusCode < 500) {
      // Untrusted 401/403 from an unrecognized thrown error — surface as
      // a normal failed-request 502, not a fake auth rejection.
      request.log.error(
        { err: error, statusCode },
        'Non-Fastify error carried a 401/403 statusCode — remapped to 502'
      )
      return reply.code(502).send({
        success: false,
        message: 'A required service is temporarily unavailable. Please try again shortly.',
        code: 'UPSTREAM_ERROR',
      })
    }

    // 500 — Internal server error
    request.log.error({ err: error }, 'Internal server error')

    const response = {
      success: false,
      message: env.NODE_ENV === 'production'
        ? 'Internal server error'
        : message,
      code: 'INTERNAL_ERROR',
    }

    if (env.NODE_ENV !== 'production') {
      response.stack = error.stack
    }

    return reply.code(500).send(response)
  })

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      message: `Route ${request.method} ${request.url} not found`,
      code: 'NOT_FOUND',
    })
  })
}

export default fp(errorHandlerPlugin, { name: 'error-handler' })
