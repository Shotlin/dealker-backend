/**
 * Integration tests — Task 23.4
 * Test manual product creation:
 *   - Happy path → exactly one row in each of products, shop_products,
 *     stock_movements, audit_logs
 *   - Collision → 409 MASTER_PRODUCT_EXISTS with existing product_id
 *
 * Endpoint: POST /api/v1/shops/:shopId/products/manual
 * Validates: R23.15–R23.24
 *
 * Requirements: R23.15, R23.16, R23.17, R23.20, R23.24
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
  notificationQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
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

const mockCacheGet = vi.fn(() => true)

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: (...args) => mockCacheGet(...args),
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
  getSocketIo: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })) })),
}))

// ─── Test fixtures ────────────────────────────────────────────
const USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const PRODUCT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SHOP_PRODUCT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const EXISTING_PRODUCT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const CATEGORY_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

const VALID_PRODUCT_BODY = {
  name: 'Organic Milk 500ml',
  description: 'Fresh organic milk',
  price: 65.00,
  sale_price: 60.00,
  cost_price: 45.00,
  category_id: CATEGORY_ID,
  stock_quantity: 100,
  unit: 'piece',
  brand: 'FarmFresh',
  low_stock_threshold: 10,
  max_order_qty: 5,
  is_available: true,
  image_ids: [],
}

// ─── App instance ─────────────────────────────────────────────
let app

function signTestToken(payload) {
  return app.jwt.sign(payload, { expiresIn: '1h' })
}

beforeAll(async () => {
  // Build a minimal Fastify app with just the shop-products nested routes.
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
      // Simulate the auth plugin's DB check
      const { rows } = mockQuery(
        'SELECT is_blocked, session_version FROM users WHERE id = $1 LIMIT 1',
        [request.user.id]
      )
      if (rows.length > 0 && rows[0].is_blocked) {
        return reply.code(403).send({ success: false, message: 'Blocked', code: 'ACCOUNT_BLOCKED' })
      }
    } catch {
      reply.code(401).send({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' })
    }
  })

  // Register shop-products nested routes (includes /manual endpoint)
  const { shopProductsNestedRoutes } = await import(
    '../../src/modules/shop-products/shop-products.routes.js'
  )
  await app.register(shopProductsNestedRoutes, {
    prefix: '/api/v1/shops/:shopId/products',
  })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

beforeEach(() => {
  vi.clearAllMocks()
  mockQuery.mockImplementation(() => ({ rows: [] }))
  mockPoolQuery.mockImplementation(() => ({ rows: [] }))
  mockCacheGet.mockImplementation(() => true)
})

// ═══════════════════════════════════════════════════════════════
// Helper: setup mock client for transaction-based operations
// ═══════════════════════════════════════════════════════════════

function setupHappyPathMocks() {
  // Auth plugin: user is not blocked
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('is_blocked') && sql.includes('session_version')) {
      return { rows: [{ is_blocked: false, session_version: null }] }
    }
    // requireShopScope: staff-active check
    if (sql.includes('shop_staff') && sql.includes('is_active')) {
      return { rows: [{ id: 'ss-1' }] }
    }
    // requirePermission: check user has shop_products.create
    if (sql.includes('permissions') && sql.includes('roles')) {
      return { rows: [{ permissions: ['shop_products.create'] }] }
    }
    return { rows: [] }
  })

  // Transaction client mock
  const mockClient = {
    query: vi.fn().mockImplementation((sql) => {
      // BEGIN
      if (sql === 'BEGIN') return { rows: [] }
      // COMMIT
      if (sql === 'COMMIT') return { rows: [] }
      // ROLLBACK
      if (sql === 'ROLLBACK') return { rows: [] }

      // Step 1: Duplicate check — no collision
      if (sql.includes('LOWER(TRIM(name))') && sql.includes('products')) {
        return { rows: [] }
      }

      // Step 2: INSERT into products
      if (sql.includes('INSERT INTO products')) {
        return {
          rows: [{
            id: PRODUCT_ID,
            name: 'Organic Milk 500ml',
            slug: 'organic-milk-500ml-abc123',
            description: 'Fresh organic milk',
            price: '65.00',
            sale_price: '60.00',
            cost_price: '45.00',
            category_id: CATEGORY_ID,
            stock_quantity: 100,
            unit: 'piece',
            images: '[]',
            brand: 'FarmFresh',
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
        }
      }

      // Step 3: INSERT into shop_products
      if (sql.includes('INSERT INTO shop_products')) {
        return {
          rows: [{
            id: SHOP_PRODUCT_ID,
            shop_id: SHOP_ID,
            product_id: PRODUCT_ID,
            price: '65.00',
            sale_price: '60.00',
            cost_price: '45.00',
            stock_quantity: 0,
            low_stock_threshold: 10,
            max_order_qty: 5,
            is_available: true,
            sold_out_at: null,
            approval_status: 'APPROVED',
            approved_at: null,
            approved_by: null,
            rejection_reason: null,
            deleted_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
        }
      }

      // Step 4: Stock movement (applyStockChange)
      // SELECT ... FOR UPDATE on shop_products
      if (sql.includes('FOR UPDATE') && sql.includes('shop_products')) {
        return {
          rows: [{
            id: SHOP_PRODUCT_ID,
            stock_quantity: 0,
            shop_id: SHOP_ID,
          }],
        }
      }
      // UPDATE shop_products SET stock_quantity
      if (sql.includes('UPDATE shop_products') && sql.includes('stock_quantity')) {
        return {
          rows: [{
            id: SHOP_PRODUCT_ID,
            shop_id: SHOP_ID,
            product_id: PRODUCT_ID,
            price: '65.00',
            sale_price: '60.00',
            cost_price: '45.00',
            stock_quantity: 100,
            low_stock_threshold: 10,
            max_order_qty: 5,
            is_available: true,
            sold_out_at: null,
            approval_status: 'APPROVED',
            approved_at: null,
            approved_by: null,
            rejection_reason: null,
            deleted_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
        }
      }
      // INSERT INTO stock_movements
      if (sql.includes('INSERT INTO stock_movements')) {
        return {
          rows: [{
            id: 'movement-1',
            shop_product_id: SHOP_PRODUCT_ID,
            type: 'MANUAL_ADJUSTMENT',
            delta: 100,
            qty_before: 0,
            qty_after: 100,
            reason: 'Initial stock from manual product creation',
            source: 'DASHBOARD',
            actor_user_id: USER_ID,
            created_at: new Date().toISOString(),
          }],
        }
      }

      // Step 5: Audit log INSERT
      if (sql.includes('INSERT INTO audit_logs')) {
        return { rows: [] }
      }

      return { rows: [] }
    }),
    release: vi.fn(),
  }

  mockGetClient.mockResolvedValue(mockClient)
  return mockClient
}

function setupCollisionMocks() {
  // Auth plugin: user is not blocked
  mockQuery.mockImplementation((sql) => {
    if (sql.includes('is_blocked') && sql.includes('session_version')) {
      return { rows: [{ is_blocked: false, session_version: null }] }
    }
    if (sql.includes('shop_staff') && sql.includes('is_active')) {
      return { rows: [{ id: 'ss-1' }] }
    }
    if (sql.includes('permissions') && sql.includes('roles')) {
      return { rows: [{ permissions: ['shop_products.create'] }] }
    }
    return { rows: [] }
  })

  const mockClient = {
    query: vi.fn().mockImplementation((sql) => {
      if (sql === 'BEGIN') return { rows: [] }
      if (sql === 'COMMIT') return { rows: [] }
      if (sql === 'ROLLBACK') return { rows: [] }

      // Step 1: Duplicate check — COLLISION found
      if (sql.includes('LOWER(TRIM(name))') && sql.includes('products')) {
        return {
          rows: [{
            id: EXISTING_PRODUCT_ID,
            name: 'Organic Milk 500ml',
            brand: 'FarmFresh',
            unit: 'piece',
          }],
        }
      }

      return { rows: [] }
    }),
    release: vi.fn(),
  }

  mockGetClient.mockResolvedValue(mockClient)
  return mockClient
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

describe('POST /api/v1/shops/:shopId/products/manual — Manual Product Creation (Task 23.4)', () => {
  describe('Happy path', () => {
    it('returns 201 with product, shop_product, and movement data', async () => {
      setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: VALID_PRODUCT_BODY,
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data).toHaveProperty('product')
      expect(body.data).toHaveProperty('shop_product')
      expect(body.data).toHaveProperty('movement')
    })

    it('creates exactly one row in products table', async () => {
      const mockClient = setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      // Count INSERT INTO products calls on the transaction client
      const productInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO products')
      )
      expect(productInserts).toHaveLength(1)
    })

    it('creates exactly one row in shop_products table', async () => {
      const mockClient = setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      const shopProductInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO shop_products')
      )
      expect(shopProductInserts).toHaveLength(1)
    })

    it('creates exactly one stock_movements row', async () => {
      const mockClient = setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      const stockInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO stock_movements')
      )
      expect(stockInserts).toHaveLength(1)
    })

    it('creates exactly one audit_logs row (manual_product_created)', async () => {
      const mockClient = setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      const auditInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO audit_logs')
      )
      expect(auditInserts).toHaveLength(1)

      // Verify the audit action is 'manual_product_created'
      const auditParams = auditInserts[0][1]
      expect(auditParams).toContain('manual_product_created')
    })

    it('commits the transaction on success', async () => {
      const mockClient = setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      const commits = mockClient.query.mock.calls.filter(
        (call) => call[0] === 'COMMIT'
      )
      expect(commits).toHaveLength(1)

      // Client is released
      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })
  })

  describe('Collision — duplicate product (name + brand + unit)', () => {
    it('returns 409 MASTER_PRODUCT_EXISTS with existing_product_id', async () => {
      setupCollisionMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      expect(res.statusCode).toBe(409)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('MASTER_PRODUCT_EXISTS')
      expect(body.existing_product_id).toBe(EXISTING_PRODUCT_ID)
    })

    it('rolls back the transaction on collision', async () => {
      const mockClient = setupCollisionMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      const rollbacks = mockClient.query.mock.calls.filter(
        (call) => call[0] === 'ROLLBACK'
      )
      expect(rollbacks).toHaveLength(1)

      // No INSERT into products should have happened
      const productInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO products')
      )
      expect(productInserts).toHaveLength(0)

      // Client is released
      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })

    it('does not create any shop_products or stock_movements on collision', async () => {
      const mockClient = setupCollisionMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: VALID_PRODUCT_BODY,
      })

      const shopProductInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO shop_products')
      )
      const stockInserts = mockClient.query.mock.calls.filter(
        (call) => call[0]?.includes?.('INSERT INTO stock_movements')
      )
      expect(shopProductInserts).toHaveLength(0)
      expect(stockInserts).toHaveLength(0)
    })
  })

  describe('Validation errors', () => {
    it('returns 400 when required fields are missing', async () => {
      setupHappyPathMocks()

      const token = signTestToken({
        id: USER_ID,
        phone: '+919876543210',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_ADMIN',
        permissions: ['shop_products.create'],
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Incomplete Product' },
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.success).toBe(false)
      expect(body.code).toBe('VALIDATION_ERROR')
    })

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/shops/${SHOP_ID}/products/manual`,
        payload: VALID_PRODUCT_BODY,
      })

      expect(res.statusCode).toBe(401)
    })
  })
})
