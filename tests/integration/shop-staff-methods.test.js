/**
 * Integration tests — Task 23.3
 * Test PATCH /staff with empty body → 400 VALIDATION_ERROR
 * Test PUT /staff → 405 Method Not Allowed
 *
 * Endpoint: /api/v1/shop-staff/:id (PATCH, PUT)
 * Validates: R29 AC#7, R29 AC#8
 *
 * Requirements: R29.7, R29.8
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════
// Mock external dependencies
// ═══════════════════════════════════════════════════════════════

const mockQuery = vi.fn()
const mockPoolQuery = vi.fn()
const mockGetClient = vi.fn()

vi.mock('../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
  pool: { query: (...args) => mockPoolQuery(...args) },
  getClient: () => mockGetClient(),
}))

vi.mock('../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(() => null),
    del: vi.fn(),
    ping: vi.fn(() => 'PONG'),
    status: 'ready',
    disconnect: vi.fn(),
    quit: vi.fn(),
  },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    JWT_ACCESS_SECRET: 'test-access-secret-32-chars-minimum-xx',
    JWT_ACCESS_EXPIRY: '24h',
    JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-minimum-xx',
    COOKIE_SECRET: 'test-cookie-secret',
    ALLOW_DEMO_OTP: false,
    DEMO_OTP_PHONE: '',
    DEMO_OTP_CODE: '123456',
    OTP_EXPIRY_SECONDS: 300,
    SMS_PROVIDER: 'none',
    CORS_ORIGIN: '*',
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW: '1 minute',
    STRICT_SESSION_VERSION_CHECK: false,
    MULTI_VENDOR_PRODUCT_APPROVAL: false,
  },
}))

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(() => true),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}))

vi.mock('../../src/config/firebase.js', () => ({
  messaging: { send: vi.fn() },
}))

vi.mock('../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))

vi.mock('../../src/utils/permission-audit.js', () => ({
  installRouteCollector: vi.fn(() => []),
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  default: async () => {},
}))

// ─── Test fixtures ────────────────────────────────────────────
const ADMIN_USER_ID = '11111111-1111-1111-1111-111111111111'
const STAFF_RECORD_ID = '99999999-9999-9999-9999-999999999999'
const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'

// ─── App instance ─────────────────────────────────────────────
let app

function signTestToken(payload) {
  return app.jwt.sign(payload, { expiresIn: '1h' })
}

beforeAll(async () => {
  // Build a minimal Fastify app with just the shop-staff routes.
  const Fastify = (await import('fastify')).default
  app = Fastify({ logger: false })
  await app.register(import('@fastify/cookie'), {
    secret: 'test-cookie-secret',
  })
  await app.register(import('@fastify/jwt'), {
    secret: 'test-access-secret-32-chars-minimum-xx',
    sign: { expiresIn: '24h' },
  })

  // Decorate authenticate
  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      reply.code(401).send({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' })
    }
  })

  // Register shop-staff routes (both mounts)
  const { default: shopStaffRoutes } = await import(
    '../../src/modules/shop-staff/shop-staff.routes.js'
  )
  await app.register(shopStaffRoutes, { prefix: '/api/v1/shop-staff' })
  await app.register(shopStaffRoutes, { prefix: '/api/v1/shops/:shopId/staff' })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

beforeEach(() => {
  vi.clearAllMocks()

  // Default mock: authenticate passes, user is ADMIN (bypasses role checks)
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('is_blocked') && sql.includes('session_version')) {
      return { rows: [{ is_blocked: false, session_version: null }] }
    }
    // Permission check for requirePermission decorator
    if (sql.includes('permissions') && sql.includes('roles')) {
      return { rows: [{ permissions: ['manage_staff'] }] }
    }
    return { rows: [] }
  })
  mockPoolQuery.mockImplementation(() => ({ rows: [] }))
})

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

describe('Shop Staff method validation (Task 23.3)', () => {
  describe('PATCH /api/v1/shop-staff/:id with empty body', () => {
    it('returns 400 VALIDATION_ERROR when body is empty object', async () => {
      const token = signTestToken({
        id: ADMIN_USER_ID,
        phone: '+919876543210',
        role: 'ADMIN',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/shop-staff/${STAFF_RECORD_ID}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-shop-id': SHOP_ID,
        },
        payload: {},
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('VALIDATION_ERROR')
      // The message should indicate at least one field is required
      expect(body.message).toMatch(/at least one/i)
    })

    it('returns 400 VALIDATION_ERROR when body has no recognized fields', async () => {
      const token = signTestToken({
        id: ADMIN_USER_ID,
        phone: '+919876543210',
        role: 'ADMIN',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/shop-staff/${STAFF_RECORD_ID}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-shop-id': SHOP_ID,
        },
        // Fastify's removeAdditional:'all' strips unknown fields,
        // leaving an effectively empty body for the Zod schema
        payload: { unknown_field: 'value' },
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('VALIDATION_ERROR')
    })

    it('accepts PATCH with valid role field (not a validation error)', async () => {
      const token = signTestToken({
        id: ADMIN_USER_ID,
        phone: '+919876543210',
        role: 'ADMIN',
      })

      // Mock the service to return success for a valid update
      mockQuery.mockImplementation((sql) => {
        if (sql.includes('is_blocked') && sql.includes('session_version')) {
          return { rows: [{ is_blocked: false, session_version: null }] }
        }
        if (sql.includes('shop_staff') && sql.includes('SELECT')) {
          return {
            rows: [{
              id: STAFF_RECORD_ID,
              shop_id: SHOP_ID,
              user_id: '22222222-2222-2222-2222-222222222222',
              role: 'SHOP_STAFF',
              permissions: [],
              is_active: true,
            }],
          }
        }
        if (sql.includes('UPDATE')) {
          return {
            rows: [{
              id: STAFF_RECORD_ID,
              shop_id: SHOP_ID,
              user_id: '22222222-2222-2222-2222-222222222222',
              role: 'SHOP_MANAGER',
              permissions: [],
              is_active: true,
            }],
          }
        }
        return { rows: [] }
      })

      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [{
            id: STAFF_RECORD_ID,
            role: 'SHOP_MANAGER',
            permissions: [],
            is_active: true,
          }],
        }),
        release: vi.fn(),
      }
      mockGetClient.mockResolvedValue(mockClient)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/shop-staff/${STAFF_RECORD_ID}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-shop-id': SHOP_ID,
        },
        payload: { role: 'SHOP_MANAGER' },
      })

      // Should not be a validation error — may be 200 or 404 depending
      // on whether the mock returns the staff record correctly
      expect(res.statusCode).not.toBe(400)
    })
  })

  describe('PUT /api/v1/shop-staff/:id', () => {
    it('returns 405 Method Not Allowed with Allow: PATCH header', async () => {
      const token = signTestToken({
        id: ADMIN_USER_ID,
        phone: '+919876543210',
        role: 'ADMIN',
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/shop-staff/${STAFF_RECORD_ID}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-shop-id': SHOP_ID,
        },
        payload: { role: 'SHOP_MANAGER' },
      })

      expect(res.statusCode).toBe(405)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('METHOD_NOT_ALLOWED')
      // Should include Allow header pointing to PATCH
      expect(res.headers.allow).toBe('PATCH')
    })

    it('returns 405 even with a valid body payload', async () => {
      const token = signTestToken({
        id: ADMIN_USER_ID,
        phone: '+919876543210',
        role: 'ADMIN',
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/shop-staff/${STAFF_RECORD_ID}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-shop-id': SHOP_ID,
        },
        payload: {
          role: 'SHOP_ADMIN',
          permissions: ['manage_orders'],
          is_active: true,
        },
      })

      expect(res.statusCode).toBe(405)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.message).toContain('PATCH')
    })

    it('returns 401 for unauthenticated PUT request (does not leak method support)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/shop-staff/${STAFF_RECORD_ID}`,
        payload: { role: 'SHOP_MANAGER' },
      })

      // Unauthenticated users see 401 before 405 — security first
      expect(res.statusCode).toBe(401)
    })
  })

  describe('PUT /api/v1/shops/:shopId/staff/:id (alias mount)', () => {
    it('also returns 405 Method Not Allowed on the nested route', async () => {
      const token = signTestToken({
        id: ADMIN_USER_ID,
        phone: '+919876543210',
        role: 'ADMIN',
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/shops/${SHOP_ID}/staff/${STAFF_RECORD_ID}`,
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: { role: 'SHOP_MANAGER' },
      })

      expect(res.statusCode).toBe(405)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('METHOD_NOT_ALLOWED')
      expect(res.headers.allow).toBe('PATCH')
    })
  })
})
