/**
 * Task 23.10 — JWT session_version invalidation on password change
 *
 * Scenario:
 *   1. User logs in → receives JWT with session_version=1
 *   2. User changes password → session_version bumps to 2 in the DB
 *   3. Old JWT (session_version=1) is used → 401 SESSION_INVALID
 *
 * The test exercises the `fastify.authenticate` decorator defined in
 * `src/plugins/auth.plugin.js` which performs a DB lookup of
 * `users.session_version` and compares it against the JWT claim. When
 * they diverge (password change incremented the row), the middleware
 * returns 401 with code SESSION_INVALID.
 *
 * We build a minimal Fastify app with the auth plugin registered, mock
 * the database to return controlled session_version values, and inject
 * requests with JWTs carrying the old version.
 *
 * Requirements: R20.8
 * Design:       §5.5 of .kiro/specs/multi-vendor-system/design.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'

// ─── Mock dependencies ──────────────────────────────────────────────────────

// We need to mock the database module so the auth plugin's SELECT query
// returns controlled values for is_blocked and session_version.
const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
  pool: { on: vi.fn(), end: vi.fn() },
  testConnection: vi.fn().mockResolvedValue(undefined),
  closePool: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/config/database.js', () => databaseMock)

// Mock env to provide JWT secrets
vi.mock('../../src/config/env.js', () => ({
  env: {
    JWT_ACCESS_SECRET: 'test-access-secret-for-session-version',
    JWT_ACCESS_EXPIRY: '1h',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_REFRESH_EXPIRY: '7d',
    COOKIE_SECRET: 'test-cookie-secret',
    STRICT_SESSION_VERSION_CHECK: true,
    NODE_ENV: 'test',
  },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue(undefined),
  },
  closeRedis: vi.fn().mockResolvedValue(undefined),
}))

// ─── Constants ──────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-access-secret-for-session-version'
const USER_ID = 'user-uuid-session-test'
const USER_PHONE = '9876543210'

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('Task 23.10: JWT session_version invalidation on password change', () => {
  let app

  beforeAll(async () => {
    // Build a minimal Fastify app with just the auth plugin and a test route
    app = Fastify({ logger: false })

    // Register the auth plugin (which decorates fastify.authenticate)
    await app.register(import('../../src/plugins/auth.plugin.js'))

    // Register a protected test route that uses fastify.authenticate
    app.get('/api/v1/test/protected', {
      preHandler: [app.authenticate],
    }, async (request) => {
      return { success: true, userId: request.user.id }
    })

    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts JWT when session_version matches the DB row', async () => {
    // Mint a JWT with session_version=1
    const token = jwt.sign(
      { id: USER_ID, phone: USER_PHONE, role: 'CUSTOMER', session_version: 1 },
      JWT_SECRET,
      { expiresIn: '1h' }
    )

    // DB returns session_version=1 (matches the token)
    databaseMock.query.mockResolvedValueOnce({
      rows: [{ is_blocked: false, session_version: 1 }],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.success).toBe(true)
    expect(body.userId).toBe(USER_ID)
  })

  it('rejects JWT with 401 SESSION_INVALID after password change bumps session_version', async () => {
    // Step 1: User logged in with session_version=1
    const oldToken = jwt.sign(
      { id: USER_ID, phone: USER_PHONE, role: 'CUSTOMER', session_version: 1 },
      JWT_SECRET,
      { expiresIn: '1h' }
    )

    // Step 2: Password change bumped session_version to 2 in the DB
    // Now the DB returns session_version=2 but the token still carries 1
    databaseMock.query.mockResolvedValueOnce({
      rows: [{ is_blocked: false, session_version: 2 }],
    })

    // Step 3: Use old token → should get 401 SESSION_INVALID
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: { authorization: `Bearer ${oldToken}` },
    })

    expect(response.statusCode).toBe(401)
    const body = JSON.parse(response.body)
    expect(body.success).toBe(false)
    expect(body.code).toBe('SESSION_INVALID')
    expect(body.message).toContain('Session is no longer valid')
  })

  it('rejects JWT with missing session_version claim when STRICT mode is enabled', async () => {
    // Legacy token without session_version claim
    const legacyToken = jwt.sign(
      { id: USER_ID, phone: USER_PHONE, role: 'CUSTOMER' },
      JWT_SECRET,
      { expiresIn: '1h' }
    )

    // DB has a session_version (user has changed password at some point)
    databaseMock.query.mockResolvedValueOnce({
      rows: [{ is_blocked: false, session_version: 3 }],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: { authorization: `Bearer ${legacyToken}` },
    })

    // In strict mode, missing claim → 401 SESSION_INVALID
    expect(response.statusCode).toBe(401)
    const body = JSON.parse(response.body)
    expect(body.success).toBe(false)
    expect(body.code).toBe('SESSION_INVALID')
  })

  it('accepts new JWT after password change (session_version=2 matches DB)', async () => {
    // After password change, user re-authenticates and gets a new token
    // with session_version=2
    const newToken = jwt.sign(
      { id: USER_ID, phone: USER_PHONE, role: 'CUSTOMER', session_version: 2 },
      JWT_SECRET,
      { expiresIn: '1h' }
    )

    // DB returns session_version=2 (matches the new token)
    databaseMock.query.mockResolvedValueOnce({
      rows: [{ is_blocked: false, session_version: 2 }],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: { authorization: `Bearer ${newToken}` },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.success).toBe(true)
    expect(body.userId).toBe(USER_ID)
  })

  it('rejects blocked user even with valid session_version', async () => {
    const token = jwt.sign(
      { id: USER_ID, phone: USER_PHONE, role: 'CUSTOMER', session_version: 1 },
      JWT_SECRET,
      { expiresIn: '1h' }
    )

    // DB returns is_blocked=true
    databaseMock.query.mockResolvedValueOnce({
      rows: [{ is_blocked: true, session_version: 1 }],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    const body = JSON.parse(response.body)
    expect(body.code).toBe('ACCOUNT_BLOCKED')
  })
})
