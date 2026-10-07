import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ─
vi.mock('../../../src/utils/jwt.js', () => ({
  signAccessToken: vi.fn(() => 'signed.jwt.token'),
  signRefreshToken: vi.fn(() => 'refresh.jwt.token'),
  generateTokenPair: vi.fn(() => ({
    accessToken: 'access.jwt',
    refreshToken: 'refresh.jwt',
  })),
  verifyToken: vi.fn(),
}))

vi.mock('../../../src/utils/otp.js', () => ({
  generateOTP: vi.fn(() => '1234'),
  storeOTP: vi.fn(),
  verifyOTP: vi.fn(),
}))

vi.mock('../../../src/utils/sms.js', () => ({
  sendSmsOtp: vi.fn(),
  verifySmsOtp: vi.fn(),
}))

vi.mock('../../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/env.js', () => ({
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

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { AuthService } from '../../../src/modules/auth/auth.service.js'
import { signAccessToken } from '../../../src/utils/jwt.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'

function makeRepoMock() {
  return {
    findByPhone: vi.fn(),
    findById: vi.fn(),
    createUser: vi.fn(),
    updateRole: vi.fn(),
    ensureRiderProfile: vi.fn(),
    getRiderProfile: vi.fn(),
    updateFcmToken: vi.fn(),
    deleteUser: vi.fn(),
    findActiveShopStaffByUserId: vi.fn(),
    findActiveShopStaffByUserAndShop: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthService.selectShop', () => {
  it('returns STAFF_INACTIVE when user does not exist', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(null)
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_INACTIVE')
  })

  it('returns STAFF_INACTIVE when user is blocked (is_active=false)', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({ id: USER_ID, is_active: false })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_INACTIVE')
  })

  it('returns STAFF_NOT_FOUND when user has no active assignment for the shop', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({ id: USER_ID, is_active: true })
    repo.findActiveShopStaffByUserAndShop.mockResolvedValueOnce(null)
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_NOT_FOUND')
  })

  it('issues a shop-scoped JWT with id, shopId, shopRole, permissions', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: USER_ID,
      phone: '+1234567890',
      role: 'CUSTOMER',
      is_active: true,
    })
    repo.findActiveShopStaffByUserAndShop.mockResolvedValueOnce({
      shop_staff_id: 'ss-id',
      shop_id: SHOP_ID,
      shop_name: 'Test Shop',
      role: 'SHOP_MANAGER',
      permissions: ['manage_orders', 'manage_inventory'],
    })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID)
    expect(result.success).toBe(true)
    expect(result.token).toBe('signed.jwt.token')
    expect(result.shop_id).toBe(SHOP_ID)
    expect(result.shop_role).toBe('SHOP_MANAGER')
    expect(result.permissions).toEqual(['manage_orders', 'manage_inventory'])

    // Validate JWT payload shape (Requirement 13.5)
    const [payload, options] = signAccessToken.mock.calls[0]
    expect(payload).toMatchObject({
      id: USER_ID,
      shopId: SHOP_ID,
      shopRole: 'SHOP_MANAGER',
      permissions: ['manage_orders', 'manage_inventory'],
    })
    expect(options).toEqual({ expiresIn: '24h' })
  })

  it('defaults permissions to [] when assignment has null permissions', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: USER_ID,
      phone: '+1234567890',
      role: 'CUSTOMER',
      is_active: true,
    })
    repo.findActiveShopStaffByUserAndShop.mockResolvedValueOnce({
      shop_id: SHOP_ID,
      shop_name: 'Test Shop',
      role: 'SHOP_VIEWER',
      permissions: null,
    })
    const service = new AuthService(repo)

    const result = await service.selectShop(USER_ID, SHOP_ID)
    expect(result.success).toBe(true)
    expect(result.permissions).toEqual([])
  })
})
