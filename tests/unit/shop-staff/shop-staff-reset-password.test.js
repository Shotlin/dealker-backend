// Unit tests for ShopStaffService.resetPassword (task 5.5 / R20.9).
//
// Mirrors the mocking pattern of shop-staff-cache-invalidation.test.js so the
// service can run end-to-end without a live Postgres or Redis. We assert:
//
//   1. STAFF_NOT_FOUND when the staff record is missing (404 path).
//   2. Successful reset returns `{ success: true, temp_password: '<12 chars>' }`
//      with the correct complexity classes (mixed case, digit, symbol).
//   3. The repository's `resetPasswordTx` is invoked with the correct
//      `userId` and a bcrypt hash at cost 12.
//   4. An audit row is emitted via `emitInTx` (transactional path) — never
//      via the fire-and-forget `emit`. The payload carries the actor ctx
//      and identifies the target via `target_type='shop_staff'` and
//      `target_id=<staff_id>`. The plaintext password and the bcrypt hash
//      are NEVER part of the audit payload (R20 AC#9 / R28 AC#5).
//   5. The transaction commits (BEGIN → COMMIT) and the client is released.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/middlewares/shop-scope.js', () => ({
  invalidateStaffActiveCache: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const auditLogMock = vi.hoisted(() => ({
  emit: vi.fn(),
  emitInTx: vi.fn(),
}))
vi.mock('../../../src/utils/audit-log.js', () => auditLogMock)

const dbMock = vi.hoisted(() => {
  const calls = []
  const fakeClient = {
    query: vi.fn(async (sql) => {
      calls.push(sql)
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
    __queries: calls,
  }
  return {
    pool: { query: vi.fn() },
    query: vi.fn(),
    getClient: vi.fn(async () => fakeClient),
    closePool: vi.fn(),
    __fakeClient: fakeClient,
  }
})
vi.mock('../../../src/config/database.js', () => dbMock)

import { ShopStaffService } from '../../../src/modules/shop-staff/shop-staff.service.js'

const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const STAFF_ID = '99999999-9999-9999-9999-999999999999'
const TARGET_USER_ID = '11111111-1111-1111-1111-111111111111'
const REQUESTER_ID = '22222222-2222-2222-2222-222222222222'

function makeRepoMock() {
  return {
    findById: vi.fn(),
    resetPasswordTx: vi.fn(async () => ({ session_version: 7 })),
    softDelete: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    countActiveByShop: vi.fn(),
    countActiveByUser: vi.fn(),
    findByUserAndShop: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the fake-client query log between tests.
  dbMock.__fakeClient.__queries.length = 0
})

describe('ShopStaffService.resetPassword', () => {
  it('returns STAFF_NOT_FOUND when the record is missing', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(null)
    const service = new ShopStaffService(repo)

    const result = await service.resetPassword(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
    })

    expect(result).toEqual({
      success: false,
      message: 'Staff record not found',
      code: 'STAFF_NOT_FOUND',
    })
    expect(repo.resetPasswordTx).not.toHaveBeenCalled()
    expect(auditLogMock.emitInTx).not.toHaveBeenCalled()
    // No tx should be opened on the 404 path.
    expect(dbMock.getClient).not.toHaveBeenCalled()
  })

  it('returns a 12-char Temp_Password with R20.3 complexity on success', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
      role: 'SHOP_STAFF',
      is_active: true,
    })
    const service = new ShopStaffService(repo)

    const result = await service.resetPassword(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
      actorPlatformRole: 'ADMIN',
      ip: '203.0.113.1',
      userAgent: 'kiro-test/1.0',
    })

    expect(result.success).toBe(true)
    expect(result.temp_password).toMatch(/^.{12}$/)
    // R20.3 — mixed case, digit, at least one symbol.
    expect(result.temp_password).toMatch(/[a-z]/)
    expect(result.temp_password).toMatch(/[A-Z]/)
    expect(result.temp_password).toMatch(/\d/)
    expect(result.temp_password).toMatch(/[!@#$%^&*()_=+\-]/)
  })

  it('hashes with bcrypt cost 12 and calls resetPasswordTx with the correct userId', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    const service = new ShopStaffService(repo)

    await service.resetPassword(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
    })

    expect(repo.resetPasswordTx).toHaveBeenCalledTimes(1)
    const [client, userId, passwordHash] = repo.resetPasswordTx.mock.calls[0]
    expect(client).toBe(dbMock.__fakeClient) // tx-bound client
    expect(userId).toBe(TARGET_USER_ID)
    // bcrypt cost 12 hashes start with $2a$/$2b$/$2y$12$.
    expect(passwordHash).toMatch(/^\$2[aby]\$12\$/)
  })

  it('emits staff_password_reset audit transactionally with correct payload (no password)', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    const service = new ShopStaffService(repo)

    await service.resetPassword(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
      actorPlatformRole: 'HQ_MANAGER',
      ip: '203.0.113.1',
      userAgent: 'kiro-test/1.0',
    })

    expect(auditLogMock.emitInTx).toHaveBeenCalledTimes(1)
    expect(auditLogMock.emit).not.toHaveBeenCalled()

    const [client, action, payload] = auditLogMock.emitInTx.mock.calls[0]
    expect(client).toBe(dbMock.__fakeClient)
    expect(action).toBe('staff_password_reset')
    expect(payload.actor_user_id).toBe(REQUESTER_ID)
    expect(payload.actor_role).toBe('HQ_MANAGER')
    expect(payload.actor_shop_id).toBe(SHOP_ID)
    expect(payload.target_type).toBe('shop_staff')
    expect(payload.target_id).toBe(STAFF_ID)
    expect(payload.before).toBeNull()
    expect(payload.after).toEqual({
      user_id: TARGET_USER_ID,
      staff_id: STAFF_ID,
    })
    expect(payload.ip_address).toBe('203.0.113.1')
    expect(payload.user_agent).toBe('kiro-test/1.0')

    // Belt-and-braces: NEITHER the bcrypt hash NOR the plaintext password
    // should appear anywhere in the serialised payload (R28 AC#5).
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toMatch(/\$2[aby]\$12\$/)
    expect(serialised).not.toMatch(/password/i)
  })

  it('runs BEGIN → COMMIT and releases the client on success', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    const service = new ShopStaffService(repo)

    await service.resetPassword(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
    })

    const queries = dbMock.__fakeClient.__queries
    expect(queries[0]).toBe('BEGIN')
    expect(queries[queries.length - 1]).toBe('COMMIT')
    expect(dbMock.__fakeClient.release).toHaveBeenCalledTimes(1)
  })

  it('runs ROLLBACK and releases the client when the tx body throws', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    repo.resetPasswordTx.mockRejectedValueOnce(new Error('DB blew up'))
    const service = new ShopStaffService(repo)

    await expect(
      service.resetPassword(STAFF_ID, SHOP_ID, { actorUserId: REQUESTER_ID })
    ).rejects.toThrow('DB blew up')

    const queries = dbMock.__fakeClient.__queries
    expect(queries[0]).toBe('BEGIN')
    expect(queries).toContain('ROLLBACK')
    expect(queries).not.toContain('COMMIT')
    expect(dbMock.__fakeClient.release).toHaveBeenCalledTimes(1)
  })
})

describe('ShopStaffService.deactivate', () => {
  it('emits staff_deactivated audit transactionally on successful soft-delete', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
      role: 'SHOP_STAFF',
      is_active: true,
    })
    repo.softDelete.mockResolvedValueOnce(true)
    const service = new ShopStaffService(repo)

    const result = await service.deactivate(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
      actorPlatformRole: 'ADMIN',
      ip: '198.51.100.7',
      userAgent: 'kiro-test/1.0',
    })

    expect(result).toEqual({ success: true })
    expect(auditLogMock.emitInTx).toHaveBeenCalledTimes(1)
    const [client, action, payload] = auditLogMock.emitInTx.mock.calls[0]
    expect(client).toBe(dbMock.__fakeClient)
    expect(action).toBe('staff_deactivated')
    expect(payload.actor_user_id).toBe(REQUESTER_ID)
    expect(payload.actor_role).toBe('ADMIN')
    expect(payload.target_type).toBe('shop_staff')
    expect(payload.target_id).toBe(STAFF_ID)
    expect(payload.before).toMatchObject({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
    })
    expect(payload.after).toBeNull()

    // softDelete is called with the tx-bound client.
    expect(repo.softDelete).toHaveBeenCalledTimes(1)
    const sdCall = repo.softDelete.mock.calls[0]
    expect(sdCall[0]).toBe(STAFF_ID)
    expect(sdCall[1]).toBe(SHOP_ID)
    expect(sdCall[2]).toEqual({ client: dbMock.__fakeClient })

    // Tx ordering: BEGIN appears before COMMIT.
    const queries = dbMock.__fakeClient.__queries
    expect(queries[0]).toBe('BEGIN')
    expect(queries[queries.length - 1]).toBe('COMMIT')
  })

  it('preserves the legacy (id, shopId, userId) signature via service.delete', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    repo.softDelete.mockResolvedValueOnce(true)
    const service = new ShopStaffService(repo)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result).toEqual({ success: true })
    expect(auditLogMock.emitInTx).toHaveBeenCalledTimes(1)
    const [, , payload] = auditLogMock.emitInTx.mock.calls[0]
    expect(payload.actor_user_id).toBe(REQUESTER_ID)
  })

  it('rolls back without emitting an audit when the row was already deleted', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    repo.softDelete.mockResolvedValueOnce(false) // race
    const service = new ShopStaffService(repo)

    const result = await service.deactivate(STAFF_ID, SHOP_ID, {
      actorUserId: REQUESTER_ID,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_NOT_FOUND')
    expect(auditLogMock.emitInTx).not.toHaveBeenCalled()

    const queries = dbMock.__fakeClient.__queries
    expect(queries[0]).toBe('BEGIN')
    expect(queries).toContain('ROLLBACK')
    expect(queries).not.toContain('COMMIT')
  })
})
