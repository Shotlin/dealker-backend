import { beforeEach, describe, expect, it, vi } from 'vitest'

const jwt = vi.hoisted(() => ({
  signAccessToken: vi.fn(() => 'signed.access'),
  signRefreshToken: vi.fn(() => 'signed.refresh'),
  generateTokenPair: vi.fn(() => ({ accessToken: 'a.jwt', refreshToken: 'r.jwt' })),
  verifyToken: vi.fn(),
}))
vi.mock('../../../src/utils/jwt.js', () => jwt)
vi.mock('../../../src/utils/otp.js', () => ({ generateOTP: vi.fn(), storeOTP: vi.fn(), verifyOTP: vi.fn(() => ({ valid: true })) }))
vi.mock('../../../src/utils/sms.js', () => ({ sendSmsOtp: vi.fn(), verifySmsOtp: vi.fn() }))
const redis = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), del: vi.fn() }))
vi.mock('../../../src/config/redis.js', () => ({ redis }))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))
vi.mock('../../../src/config/env.js', () => ({
  env: { NODE_ENV: 'test', ALLOW_DEMO_OTP: false, DEMO_OTP_CODE: '123456', SMS_PROVIDER: 'none', JWT_REFRESH_SECRET: 'x'.repeat(32), JWT_ACCESS_SECRET: 'y'.repeat(32) },
}))
vi.mock('../../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../src/config/database.js', () => ({ query: vi.fn() }))

import { AuthService, resolveActingRole, refreshKeyFor } from '../../../src/modules/auth/auth.service.js'

const repoFor = (user) => ({
  findByPhone: vi.fn(async () => ({ ...user })),
  createUser: vi.fn(),
  updateRole: vi.fn(),
  ensureRiderProfile: vi.fn(),
  getRiderProfile: vi.fn(async () => ({ is_approved: true })),
  findActiveShopStaffByUserId: vi.fn(async () => []),
  findActiveVendorUsersByUserId: vi.fn(async () => []),
  findById: vi.fn(async () => ({ ...user })),
})
const customer = { id: 'u1', phone: '9111111111', role: 'CUSTOMER', is_active: true }

describe('multi-role accounts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolveActingRole: app decides the role, staff roles never relabelled', () => {
    expect(resolveActingRole('CUSTOMER', 'RIDER')).toBe('RIDER')
    expect(resolveActingRole('CUSTOMER', null)).toBe('CUSTOMER')
    expect(resolveActingRole('RIDER', null)).toBe('CUSTOMER') // legacy flipped account, customer app
    expect(resolveActingRole('RIDER', 'RIDER')).toBe('RIDER')
    expect(resolveActingRole('ADMIN', 'RIDER')).toBe('ADMIN')
    expect(resolveActingRole('ADMIN', null)).toBe('ADMIN')
  })

  it('refresh keys are separate per app', () => {
    expect(refreshKeyFor('u1', 'RIDER')).not.toBe(refreshKeyFor('u1', 'CUSTOMER'))
    expect(refreshKeyFor('u1', 'CUSTOMER')).toBe('refresh:u1')
  })

  it('rider-app login on a customer account never rewrites users.role', async () => {
    const repo = repoFor(customer)
    const res = await new AuthService(repo).verifyOtp('9111111111', '123456', 'RIDER')
    expect(res.success).toBe(true)
    expect(repo.updateRole).not.toHaveBeenCalled()
    expect(repo.ensureRiderProfile).toHaveBeenCalled()
    expect(jwt.generateTokenPair).toHaveBeenCalledWith(expect.objectContaining({ role: 'RIDER' }))
    expect(redis.set.mock.calls[0][0]).toBe('refresh:u1:RIDER')
  })

  it('customer-app login on a legacy RIDER-flipped account acts as CUSTOMER', async () => {
    const repo = repoFor({ ...customer, role: 'RIDER' })
    await new AuthService(repo).verifyOtp('9111111111', '123456')
    expect(jwt.generateTokenPair).toHaveBeenCalledWith(expect.objectContaining({ role: 'CUSTOMER' }))
    expect(redis.set.mock.calls[0][0]).toBe('refresh:u1')
  })

  it('new rider-app user is stored as CUSTOMER with a rider profile', async () => {
    const repo = repoFor(customer)
    repo.findByPhone.mockResolvedValueOnce(null)
    repo.createUser.mockResolvedValueOnce({ ...customer })
    await new AuthService(repo).verifyOtp('9111111111', '123456', 'RIDER')
    expect(repo.createUser).toHaveBeenCalledWith('9111111111', 'CUSTOMER')
    expect(repo.ensureRiderProfile).toHaveBeenCalled()
  })

  it('a rider refresh token refreshes as RIDER and does not touch the customer key', async () => {
    const repo = repoFor(customer)
    jwt.verifyToken.mockReturnValue({ id: 'u1', role: 'RIDER' })
    redis.get.mockImplementation(async (k) => (k === 'refresh:u1:RIDER' ? 'rt' : null))
    const res = await new AuthService(repo).refreshToken('rt')
    expect(res.success).toBe(true)
    expect(jwt.generateTokenPair).toHaveBeenCalledWith(expect.objectContaining({ role: 'RIDER' }))
    expect(redis.set.mock.calls[0][0]).toBe('refresh:u1:RIDER')
  })

  it('logout ends only that app\'s session', async () => {
    await new AuthService(repoFor(customer)).logout('u1', 'RIDER')
    expect(redis.del).toHaveBeenCalledWith('refresh:u1:RIDER')
    expect(redis.del).not.toHaveBeenCalledWith('refresh:u1')
  })
})
