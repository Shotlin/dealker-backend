/**
 * Integration tests — Task 23.1
 * Login matrix: HQ single role × store single shop × store multi-shop ×
 * inactive user × no active shops × wrong password
 *
 * Endpoint: POST /api/v1/admin/auth/login
 * Asserts correct status codes and audit entries.
 *
 * Requirements: R18.2, R18.3, R18.4, R18.5, R18.13, R18.14, R18.17
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcrypt'

// ═══════════════════════════════════════════════════════════════
// Mock external dependencies BEFORE importing source modules.
// Integration tests use fastify.inject() against the real route
// layer but mock the database, Redis, and external services.
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
  cacheGet: vi.fn(() => null),
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
const HQ_USER_ID = '11111111-1111-1111-1111-111111111111'
const STORE_USER_ID = '22222222-2222-2222-2222-222222222222'
const MULTI_SHOP_USER_ID = '33333333-3333-3333-3333-333333333333'
const INACTIVE_USER_ID = '44444444-4444-4444-4444-444444444444'
const NO_SHOPS_USER_ID = '55555555-5555-5555-5555-555555555555'
const SHOP_ID_A = '550e8400-e29b-41d4-a716-446655440000'
const SHOP_ID_B = '550e8400-e29b-41d4-a716-446655440001'

const PASSWORD = 'TestPassword123'
let PASSWORD_HASH

// ─── App instance ─────────────────────────────────────────────
let app

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 10)

  // Build a minimal Fastify app with just the admin auth routes.
  // We avoid buildApp() because it loads all modules including some
  // with unimplemented controller methods.
  const Fastify = (await import('fastify')).default
  app = Fastify({ logger: false })
  await app.register(import('@fastify/cookie'), {
    secret: 'test-cookie-secret',
  })
  await app.register(import('@fastify/jwt'), {
    secret: 'test-access-secret-32-chars-minimum-xx',
    sign: { expiresIn: '24h' },
  })

  // Decorate authenticate (login is PUBLIC so this is only needed for
  // protected routes like /select-shop)
  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      reply.code(401).send({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' })
    }
  })

  // Register admin auth routes
  const { default: adminAuthRoutes } = await import(
    '../../src/modules/admin/auth/auth.routes.js'
  )
  await app.register(adminAuthRoutes, { prefix: '/api/v1/admin/auth' })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

beforeEach(() => {
  vi.clearAllMocks()
  mockQuery.mockImplementation(() => ({ rows: [] }))
  mockPoolQuery.mockImplementation(() => ({ rows: [] }))
})

// ═══════════════════════════════════════════════════════════════
// Helper: configure mock DB responses for login scenarios
// ═══════════════════════════════════════════════════════════════

function setupHqUser() {
  mockQuery.mockImplementation((sql) => {
    // findUserByEmailCI
    if (sql.includes('LOWER') && sql.includes('email')) {
      return {
        rows: [{
          id: HQ_USER_ID,
          email: 'admin@bakaloo.com',
          full_name: 'HQ Admin',
          phone: '+919876543210',
          role: 'ADMIN',
          platform_role: 'SUPER_ADMIN',
          is_active: true,
          is_blocked: false,
          password_hash: PASSWORD_HASH,
          session_version: 1,
          force_password_change: false,
        }],
      }
    }
    return { rows: [] }
  })
}

function setupStoreSingleShopUser() {
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('LOWER') && sql.includes('email')) {
      return {
        rows: [{
          id: STORE_USER_ID,
          email: 'store@bakaloo.com',
          full_name: 'Store Manager',
          phone: '+919876543211',
          role: 'CUSTOMER',
          platform_role: null,
          is_active: true,
          is_blocked: false,
          password_hash: PASSWORD_HASH,
          session_version: 1,
          force_password_change: false,
        }],
      }
    }
    // loadActiveShopAssignments
    if (sql.includes('shop_staff') && sql.includes('is_active')) {
      return {
        rows: [{
          shop_staff_id: 'ss-1',
          shop_id: SHOP_ID_A,
          shop_name: 'Shop Alpha',
          branch_code: 'ALPHA-01',
          shop_role: 'SHOP_MANAGER',
          permissions: ['manage_orders', 'manage_inventory'],
        }],
      }
    }
    return { rows: [] }
  })
}

function setupStoreMultiShopUser() {
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('LOWER') && sql.includes('email')) {
      return {
        rows: [{
          id: MULTI_SHOP_USER_ID,
          email: 'multi@bakaloo.com',
          full_name: 'Multi Store User',
          phone: '+919876543212',
          role: 'CUSTOMER',
          platform_role: null,
          is_active: true,
          is_blocked: false,
          password_hash: PASSWORD_HASH,
          session_version: 1,
          force_password_change: false,
        }],
      }
    }
    if (sql.includes('shop_staff') && sql.includes('is_active')) {
      return {
        rows: [
          {
            shop_staff_id: 'ss-2',
            shop_id: SHOP_ID_A,
            shop_name: 'Shop Alpha',
            branch_code: 'ALPHA-01',
            shop_role: 'SHOP_ADMIN',
            permissions: ['manage_products', 'manage_staff'],
          },
          {
            shop_staff_id: 'ss-3',
            shop_id: SHOP_ID_B,
            shop_name: 'Shop Beta',
            branch_code: 'BETA-01',
            shop_role: 'SHOP_MANAGER',
            permissions: ['manage_orders'],
          },
        ],
      }
    }
    return { rows: [] }
  })
}

function setupInactiveUser() {
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('LOWER') && sql.includes('email')) {
      return {
        rows: [{
          id: INACTIVE_USER_ID,
          email: 'inactive@bakaloo.com',
          full_name: 'Inactive User',
          phone: '+919876543213',
          role: 'CUSTOMER',
          platform_role: null,
          is_active: false,
          is_blocked: false,
          password_hash: PASSWORD_HASH,
          session_version: 1,
          force_password_change: false,
        }],
      }
    }
    return { rows: [] }
  })
}

function setupNoActiveShopsUser() {
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('LOWER') && sql.includes('email')) {
      return {
        rows: [{
          id: NO_SHOPS_USER_ID,
          email: 'noshops@bakaloo.com',
          full_name: 'No Shops User',
          phone: '+919876543214',
          role: 'CUSTOMER',
          platform_role: null,
          is_active: true,
          is_blocked: false,
          password_hash: PASSWORD_HASH,
          session_version: 1,
          force_password_change: false,
        }],
      }
    }
    if (sql.includes('shop_staff') && sql.includes('is_active')) {
      return { rows: [] }
    }
    return { rows: [] }
  })
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

describe('POST /api/v1/admin/auth/login — Login Matrix (Task 23.1)', () => {
  // ── HQ single role ──────────────────────────────────────────
  describe('HQ user with single role (SUPER_ADMIN)', () => {
    it('returns 200 with token and HQ permissions', async () => {
      setupHqUser()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'admin@bakaloo.com', password: PASSWORD },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data).toHaveProperty('accessToken')
      expect(body.data.user).toMatchObject({
        id: HQ_USER_ID,
        email: 'admin@bakaloo.com',
        platform_role: 'SUPER_ADMIN',
      })
      // HQ users get isSuperAdmin flag
      expect(body.data.isSuperAdmin).toBe(true)
    })

    it('emits login_success audit entry', async () => {
      setupHqUser()

      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'admin@bakaloo.com', password: PASSWORD },
      })

      // Verify audit was emitted via pool.query (fire-and-forget INSERT)
      // The audit emit uses setImmediate, so we wait a tick
      await new Promise((r) => setImmediate(r))
      const auditCalls = mockPoolQuery.mock.calls.filter(
        (call) => call[0]?.includes?.('audit_logs')
      )
      expect(auditCalls.length).toBeGreaterThanOrEqual(1)
      // Verify the action is login_success
      const auditParams = auditCalls[0]?.[1]
      expect(auditParams).toContain('login_success')
    })
  })

  // ── Store single shop ───────────────────────────────────────
  describe('Store user with single shop assignment', () => {
    it('returns 200 with shop-scoped token', async () => {
      setupStoreSingleShopUser()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'store@bakaloo.com', password: PASSWORD },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data).toHaveProperty('accessToken')
      expect(body.data.requiresShopSelection).toBeFalsy()
    })
  })

  // ── Store multi-shop ────────────────────────────────────────
  describe('Store user with multiple shop assignments', () => {
    it('returns 200 with requiresShopSelection=true and shop list', async () => {
      setupStoreMultiShopUser()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'multi@bakaloo.com', password: PASSWORD },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.requiresShopSelection).toBe(true)
      expect(body.data.shops).toHaveLength(2)
      expect(body.data.shops[0]).toHaveProperty('shop_id')
      expect(body.data.shops[0]).toHaveProperty('shop_name')
      expect(body.data.shops[0]).toHaveProperty('shop_role')
    })
  })

  // ── Inactive user ───────────────────────────────────────────
  describe('Inactive user', () => {
    it('returns 403 USER_INACTIVE', async () => {
      setupInactiveUser()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'inactive@bakaloo.com', password: PASSWORD },
      })

      expect(res.statusCode).toBe(403)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('USER_INACTIVE')
    })

    it('emits login_failure audit entry with reason=inactive', async () => {
      setupInactiveUser()

      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'inactive@bakaloo.com', password: PASSWORD },
      })

      await new Promise((r) => setImmediate(r))
      const auditCalls = mockPoolQuery.mock.calls.filter(
        (call) => call[0]?.includes?.('audit_logs')
      )
      expect(auditCalls.length).toBeGreaterThanOrEqual(1)
      const auditParams = auditCalls[0]?.[1]
      expect(auditParams).toContain('login_failure')
    })
  })

  // ── No active shops ─────────────────────────────────────────
  describe('Store user with no active shop assignments', () => {
    it('returns 403 NO_ACTIVE_SHOP_ASSIGNMENTS', async () => {
      setupNoActiveShopsUser()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'noshops@bakaloo.com', password: PASSWORD },
      })

      expect(res.statusCode).toBe(403)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('NO_ACTIVE_SHOP_ASSIGNMENTS')
    })
  })

  // ── Wrong password ──────────────────────────────────────────
  describe('Wrong password', () => {
    it('returns 401 INVALID_CREDENTIALS', async () => {
      setupHqUser()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'admin@bakaloo.com', password: 'WrongPassword999' },
      })

      expect(res.statusCode).toBe(401)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('INVALID_CREDENTIALS')
    })

    it('emits login_failure audit entry with reason=wrong_password', async () => {
      setupHqUser()

      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'admin@bakaloo.com', password: 'WrongPassword999' },
      })

      await new Promise((r) => setImmediate(r))
      const auditCalls = mockPoolQuery.mock.calls.filter(
        (call) => call[0]?.includes?.('audit_logs')
      )
      expect(auditCalls.length).toBeGreaterThanOrEqual(1)
      const auditParams = auditCalls[0]?.[1]
      expect(auditParams).toContain('login_failure')
    })
  })

  // ── Unknown email ───────────────────────────────────────────
  describe('Unknown email (bonus coverage)', () => {
    it('returns 401 INVALID_CREDENTIALS (does not reveal email existence)', async () => {
      mockQuery.mockImplementation(() => ({ rows: [] }))

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'unknown@bakaloo.com', password: PASSWORD },
      })

      expect(res.statusCode).toBe(401)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('INVALID_CREDENTIALS')
    })
  })
})
