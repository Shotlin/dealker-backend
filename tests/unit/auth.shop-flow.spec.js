import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════
// Mock external dependencies BEFORE importing source modules.
// These tests cover the full shop-staff branch of the auth flow:
//   - single active assignment   → JWT issued directly (Req 2.6, 2.8)
//   - multiple active assignments → shop list returned (Req 2.7)
//   - POST /auth/select-shop      → JWT scoped to selected shop (Req 2.8)
//   - deactivated staff rejection → STAFF_INACTIVE within 5 min (Req 2.11)
//   - JWT payload + permissions   → matches design.md security model (Req 13.4)
//
// All boundary collaborators (jwt, redis, otp, sms, sql, cache, env, logger)
// are mocked so the suite is hermetic and runs without I/O.
// ═══════════════════════════════════════════════════════════════

vi.mock('../../src/utils/jwt.js', () => ({
  signAccessToken: vi.fn(() => 'signed.access.jwt'),
  signRefreshToken: vi.fn(() => 'signed.refresh.jwt'),
  generateTokenPair: vi.fn(() => ({
    accessToken: 'access.jwt',
    refreshToken: 'refresh.jwt',
  })),
  verifyToken: vi.fn(),
}))

vi.mock('../../src/utils/otp.js', () => ({
  generateOTP: vi.fn(() => '123456'),
  storeOTP: vi.fn(),
  verifyOTP: vi.fn(() => ({ valid: true })),
}))

vi.mock('../../src/utils/sms.js', () => ({
  sendSmsOtp: vi.fn(),
  verifySmsOtp: vi.fn(),
}))

vi.mock('../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(() => null),
    del: vi.fn(),
  },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    ALLOW_DEMO_OTP: false,
    DEMO_OTP_PHONE: '',
    DEMO_OTP_CODE: '123456',
    OTP_EXPIRY_SECONDS: 300,
    SMS_PROVIDER: 'none',
    TWO_FACTOR_API_KEY: undefined,
    JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-min-x',
    JWT_ACCESS_SECRET: 'test-access-secret-32-chars-min-xx',
  },
}))

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { AuthService } from '../../src/modules/auth/auth.service.js'
import { signAccessToken, signRefreshToken } from '../../src/utils/jwt.js'
import { redis } from '../../src/config/redis.js'
import { requireShopScope } from '../../src/middlewares/shop-scope.js'
import { cacheGet } from '../../src/utils/cache.js'
import { query } from '../../src/config/database.js'

// ─── Test fixtures ────────────────────────────────────────────
const USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_ID_A = '550e8400-e29b-41d4-a716-446655440000'
const SHOP_ID_B = '550e8400-e29b-41d4-a716-446655440001'
const PHONE = '+919876543210'

const ACTIVE_USER = {
  id: USER_ID,
  phone: PHONE,
  name: 'Test User',
  role: 'CUSTOMER',
  is_active: true,
}

const ASSIGNMENT_A = {
  shop_staff_id: 'ss-a',
  shop_id: SHOP_ID_A,
  shop_name: 'Shop Alpha',
  role: 'SHOP_MANAGER',
  permissions: ['manage_orders', 'manage_inventory'],
}

const ASSIGNMENT_B = {
  shop_staff_id: 'ss-b',
  shop_id: SHOP_ID_B,
  shop_name: 'Shop Beta',
  role: 'SHOP_ADMIN',
  permissions: ['manage_products', 'manage_staff', 'manage_orders'],
}

function makeAuthRepoMock({
  byPhone = ACTIVE_USER,
  byId = ACTIVE_USER,
  staffAssignments = [],
  staffAssignmentForShop = null,
} = {}) {
  return {
    findByPhone: vi.fn().mockResolvedValue(byPhone),
    findById: vi.fn().mockResolvedValue(byId),
    createUser: vi.fn(),
    updateRole: vi.fn(),
    ensureRiderProfile: vi.fn(),
    getRiderProfile: vi.fn(),
    updateFcmToken: vi.fn(),
    deleteUser: vi.fn(),
    findActiveShopStaffByUserId: vi.fn().mockResolvedValue(staffAssignments),
    findActiveShopStaffByUserAndShop: vi
      .fn()
      .mockResolvedValue(staffAssignmentForShop),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Single active shop assignment → JWT issued directly
// Validates Requirements 2.6, 2.8, 13.2, 13.4
// ═══════════════════════════════════════════════════════════════
describe('AuthService.verifyOtp — single active shop assignment', () => {
  it('issues a shop-scoped access token with id, shopId, shopRole, permissions', async () => {
    const repo = makeAuthRepoMock({ staffAssignments: [ASSIGNMENT_A] })
    const service = new AuthService(repo)

    const result = await service.verifyOtp(PHONE, '123456')

    expect(result.success).toBe(true)
    expect(result.requires_shop_selection).toBeUndefined()
    expect(result.accessToken).toBe('signed.access.jwt')
    expect(result.refreshToken).toBe('signed.refresh.jwt')

    // JWT payload — Requirement 13.4
    expect(signAccessToken).toHaveBeenCalledTimes(1)
    const [payload, options] = signAccessToken.mock.calls[0]
    expect(payload).toMatchObject({
      id: USER_ID,
      phone: PHONE,
      role: 'CUSTOMER',
      shopId: SHOP_ID_A,
      shopRole: 'SHOP_MANAGER',
      permissions: ['manage_orders', 'manage_inventory'],
    })
    // 24h expiry — Requirement 2.8
    expect(options).toEqual({ expiresIn: '24h' })

    // Refresh token does NOT carry shop scope (matches existing behavior)
    expect(signRefreshToken).toHaveBeenCalledWith({
      id: USER_ID,
      phone: PHONE,
      role: 'CUSTOMER',
    })

    // User payload mirrors shop_id, shop_role, permissions
    expect(result.user).toMatchObject({
      id: USER_ID,
      role: 'CUSTOMER',
      shop_id: SHOP_ID_A,
      shop_role: 'SHOP_MANAGER',
      permissions: ['manage_orders', 'manage_inventory'],
    })

    // Refresh token persisted in Redis with 7-day TTL
    expect(redis.set).toHaveBeenCalledWith(
      `refresh:${USER_ID}`,
      'signed.refresh.jwt',
      'EX',
      7 * 24 * 60 * 60
    )
  })

  it('defaults permissions to [] when assignment has null permissions', async () => {
    const repo = makeAuthRepoMock({
      staffAssignments: [{ ...ASSIGNMENT_A, permissions: null }],
    })
    const service = new AuthService(repo)

    const result = await service.verifyOtp(PHONE, '123456')

    expect(result.success).toBe(true)
    expect(result.user.permissions).toEqual([])
    const [payload] = signAccessToken.mock.calls[0]
    expect(payload.permissions).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════
// Multiple active shop assignments → returns shop list for selection
// Validates Requirement 2.7, 13.3
// ═══════════════════════════════════════════════════════════════
describe('AuthService.verifyOtp — multiple active shop assignments', () => {
  it('returns the shop list with id, name, role and a temp token (no refresh token)', async () => {
    const repo = makeAuthRepoMock({
      staffAssignments: [ASSIGNMENT_A, ASSIGNMENT_B],
    })
    const service = new AuthService(repo)

    const result = await service.verifyOtp(PHONE, '123456')

    expect(result.success).toBe(true)
    expect(result.requires_shop_selection).toBe(true)
    expect(result.temp_token).toBe('signed.access.jwt')
    expect(result.shops).toEqual([
      { shop_id: SHOP_ID_A, shop_name: 'Shop Alpha', shop_role: 'SHOP_MANAGER' },
      { shop_id: SHOP_ID_B, shop_name: 'Shop Beta', shop_role: 'SHOP_ADMIN' },
    ])

    // Temp token is short-lived and includes the requires_shop_selection flag
    const [payload, options] = signAccessToken.mock.calls[0]
    expect(payload).toMatchObject({
      id: USER_ID,
      phone: PHONE,
      role: 'CUSTOMER',
      requires_shop_selection: true,
    })
    expect(payload.shopId).toBeUndefined()
    expect(payload.permissions).toBeUndefined()
    expect(options).toEqual({ expiresIn: '10m' })

    // Refresh token NOT issued for multi-shop login
    expect(signRefreshToken).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════
// POST /api/v1/auth/select-shop → issues JWT scoped to that shop
// Validates Requirement 2.8, 13.2, 13.5
// ═══════════════════════════════════════════════════════════════
describe('AuthService.selectShop', () => {
  it('issues a 24h shop-scoped JWT with the selected shops id, role, permissions', async () => {
    const repo = makeAuthRepoMock({
      byId: ACTIVE_USER,
      staffAssignmentForShop: ASSIGNMENT_B,
    })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID_B)

    expect(result).toEqual({
      success: true,
      token: 'signed.access.jwt',
      shop_id: SHOP_ID_B,
      shop_role: 'SHOP_ADMIN',
      permissions: ['manage_products', 'manage_staff', 'manage_orders'],
    })

    // Repository was queried by (user_id, shop_id) — Requirement 2.8
    expect(repo.findActiveShopStaffByUserAndShop).toHaveBeenCalledWith(
      USER_ID,
      SHOP_ID_B
    )

    // Token payload includes id + shop scope + permissions; expiry 24h
    const [payload, options] = signAccessToken.mock.calls[0]
    expect(payload).toMatchObject({
      id: USER_ID,
      phone: PHONE,
      role: 'CUSTOMER',
      shopId: SHOP_ID_B,
      shopRole: 'SHOP_ADMIN',
      permissions: ['manage_products', 'manage_staff', 'manage_orders'],
    })
    expect(options).toEqual({ expiresIn: '24h' })
  })

  it('rejects with STAFF_NOT_FOUND when user has no assignment for the shop', async () => {
    const repo = makeAuthRepoMock({
      byId: ACTIVE_USER,
      staffAssignmentForShop: null,
    })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID_A)

    // Consistent error shape — { success: false, message, code }
    expect(result).toEqual({
      success: false,
      message: 'No active shop assignment found for this user and shop',
      code: 'STAFF_NOT_FOUND',
    })
    expect(signAccessToken).not.toHaveBeenCalled()
  })

  it('rejects with STAFF_INACTIVE when the user account is blocked', async () => {
    const repo = makeAuthRepoMock({
      byId: { ...ACTIVE_USER, is_active: false },
    })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID_A)

    expect(result).toEqual({
      success: false,
      message: 'User account is not active',
      code: 'STAFF_INACTIVE',
    })
    expect(repo.findActiveShopStaffByUserAndShop).not.toHaveBeenCalled()
  })

  it('rejects with STAFF_INACTIVE when the user does not exist', async () => {
    const repo = makeAuthRepoMock({ byId: null })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID_A)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_INACTIVE')
  })
})

// ═══════════════════════════════════════════════════════════════
// Deactivated staff record rejected within 5 minutes (Requirement 2.11)
// The 5-minute SLA is implemented via the staff-active cache TTL of 300s
// in the shop-scope middleware. We assert the middleware rejects with
// STAFF_INACTIVE both when the cache reflects the deactivation and when
// the cache misses (DB returns no active row).
// ═══════════════════════════════════════════════════════════════
describe('shop-scope middleware — deactivated staff rejection (Req 2.11)', () => {
  function makeRequest(user) {
    return { user, headers: {}, shopId: undefined }
  }

  function makeReply() {
    const reply = {
      statusCode: null,
      payload: null,
      code(c) {
        this.statusCode = c
        return this
      },
      send(p) {
        this.payload = p
        return this
      },
    }
    return reply
  }

  it('rejects with 403 STAFF_INACTIVE when the staff-active cache flag is false', async () => {
    cacheGet.mockResolvedValueOnce(false)
    const handler = requireShopScope()
    const req = makeRequest({
      id: USER_ID,
      shopId: SHOP_ID_A,
      role: 'CUSTOMER',
    })
    const reply = makeReply()

    await handler(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Shop assignment is no longer active',
      code: 'STAFF_INACTIVE',
    })
    // Cached negative result skips the DB
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects with 403 STAFF_INACTIVE on cache miss when DB has no active record', async () => {
    cacheGet.mockResolvedValueOnce(null)
    query.mockResolvedValueOnce({ rows: [] })

    const handler = requireShopScope()
    const req = makeRequest({
      id: USER_ID,
      shopId: SHOP_ID_A,
      role: 'CUSTOMER',
    })
    const reply = makeReply()

    await handler(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload.code).toBe('STAFF_INACTIVE')
  })

  it('admits a request when the staff record is still active (cache hit true)', async () => {
    cacheGet.mockResolvedValueOnce(true)
    const handler = requireShopScope()
    const req = makeRequest({
      id: USER_ID,
      shopId: SHOP_ID_A,
      role: 'CUSTOMER',
    })
    const reply = makeReply()

    await handler(req, reply)

    expect(reply.statusCode).toBeNull()
    expect(req.shopId).toBe(SHOP_ID_A)
  })
})
