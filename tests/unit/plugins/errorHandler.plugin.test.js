import { describe, expect, it, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

import errorHandlerPlugin from '../../../src/plugins/errorHandler.plugin.js'

/**
 * Coverage for the 2026-07-03 production incident: a thrown error whose
 * `statusCode` happened to be 401 (from the Razorpay SDK mirroring
 * Razorpay's own API rejection) was being forwarded to the client
 * verbatim by the global error handler, making an unrelated upstream
 * provider failure look exactly like the customer's own session being
 * invalid. Only genuine Fastify/plugin errors (FST_-prefixed `code`)
 * are trusted to carry a 401/403 through; anything else is remapped to
 * 502 so provider outages are never confused with app auth failures.
 */

async function buildApp(handler) {
  const app = Fastify()
  await app.register(errorHandlerPlugin)
  app.get('/boom', handler)
  await app.ready()
  return app
}

describe('errorHandler.plugin — untrusted 401/403 remap (negative, the bug fix)', () => {
  it('remaps a non-Fastify thrown 401 (e.g. a third-party SDK error) to 502, not 401', async () => {
    const app = await buildApp(async () => {
      const err = new Error('Authentication failed')
      err.statusCode = 401
      err.error = { code: 'BAD_REQUEST_ERROR' }
      throw err
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })

    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('UPSTREAM_ERROR')
  })

  it('remaps a non-Fastify thrown 403 the same way', async () => {
    const app = await buildApp(async () => {
      const err = new Error('Forbidden by upstream')
      err.statusCode = 403
      throw err
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })

    expect(res.statusCode).toBe(502)
  })
})

describe('errorHandler.plugin — trusted Fastify auth errors pass through (positive, regression guard)', () => {
  it('still returns 401 for a genuine Fastify-coded auth error', async () => {
    const app = await buildApp(async () => {
      const err = new Error('Authorization token expired')
      err.statusCode = 401
      err.code = 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED'
      throw err
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('FST_JWT_AUTHORIZATION_TOKEN_EXPIRED')
  })

  it('still passes through other < 500 statuses unaffected (e.g. a plain 404)', async () => {
    const app = await buildApp(async () => {
      const err = new Error('Not found')
      err.statusCode = 404
      throw err
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })

    expect(res.statusCode).toBe(404)
  })

  it('still maps validation errors to 400 unaffected', async () => {
    const app = await buildApp(async () => {
      const err = new Error('bad body')
      err.validation = [{ instancePath: '/orderId', message: 'must be a string' }]
      throw err
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })

  it('still maps unknown 500s to a generic internal error', async () => {
    const app = await buildApp(async () => {
      throw new Error('kaboom')
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })

    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('INTERNAL_ERROR')
  })
})
