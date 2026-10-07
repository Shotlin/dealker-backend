import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing middleware ──
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  requireShopScope,
  staffActiveCacheKey,
  invalidateStaffActiveCache,
} from '../../../src/middlewares/shop-scope.js'
import { cacheGet, cacheSet, cacheDel } from '../../../src/utils/cache.js'
import { query } from '../../../src/config/database.js'

// ─── Helpers ─────────────────────────────────────────────────
const STAFF_USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222'

function makeRequest({ user, headers = {} } = {}) {
  return {
    user,
    headers,
    shopId: undefined,
  }
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

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Cache key shape
// ═══════════════════════════════════════════════════════════════
describe('staffActiveCacheKey', () => {
  it('produces the documented bakaloo:staff-active:v1:{user}:{shop} pattern', () => {
    expect(staffActiveCacheKey(STAFF_USER_ID, SHOP_ID)).toBe(
      `bakaloo:staff-active:v1:${STAFF_USER_ID}:${SHOP_ID}`
    )
  })
})

describe('invalidateStaffActiveCache', () => {
  it('deletes the matching cache key', async () => {
    await invalidateStaffActiveCache(STAFF_USER_ID, SHOP_ID)
    expect(cacheDel).toHaveBeenCalledWith(
      `bakaloo:staff-active:v1:${STAFF_USER_ID}:${SHOP_ID}`
    )
  })

  it('is a no-op when arguments are missing', async () => {
    await invalidateStaffActiveCache(null, SHOP_ID)
    await invalidateStaffActiveCache(STAFF_USER_ID, null)
    expect(cacheDel).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════
// requireShopScope — Shop-scoped staff JWT branch
// ═══════════════════════════════════════════════════════════════
describe('requireShopScope — staff JWT', () => {
  it('rejects with 401 when request.user is missing', async () => {
    const handler = requireShopScope()
    const req = makeRequest({ user: null })
    const reply = makeReply()

    await handler(req, reply)
    expect(reply.statusCode).toBe(401)
    expect(reply.payload.code).toBe('UNAUTHORIZED')
  })

  it('attaches request.shopId from JWT when staff is active (cache hit)', async () => {
    cacheGet.mockResolvedValueOnce(true)
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: STAFF_USER_ID, shopId: SHOP_ID, role: 'CUSTOMER' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(req.shopId).toBe(SHOP_ID)
    expect(reply.statusCode).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('falls back to DB on cache miss and caches the result', async () => {
    cacheGet.mockResolvedValueOnce(null)
    query.mockResolvedValueOnce({ rows: [{ id: 'staff-row-id' }] })

    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: STAFF_USER_ID, shopId: SHOP_ID, role: 'CUSTOMER' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(req.shopId).toBe(SHOP_ID)
    expect(query).toHaveBeenCalledTimes(1)
    expect(cacheSet).toHaveBeenCalledWith(
      `bakaloo:staff-active:v1:${STAFF_USER_ID}:${SHOP_ID}`,
      true,
      300
    )
    expect(reply.statusCode).toBeNull()
  })

  it('rejects with 403 STAFF_INACTIVE when staff record is gone (cached false)', async () => {
    cacheGet.mockResolvedValueOnce(false)
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: STAFF_USER_ID, shopId: SHOP_ID, role: 'CUSTOMER' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(reply.statusCode).toBe(403)
    expect(reply.payload.code).toBe('STAFF_INACTIVE')
  })

  it('rejects with 403 STAFF_INACTIVE when DB returns no active record', async () => {
    cacheGet.mockResolvedValueOnce(null)
    query.mockResolvedValueOnce({ rows: [] })

    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: STAFF_USER_ID, shopId: SHOP_ID, role: 'CUSTOMER' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(reply.statusCode).toBe(403)
    expect(reply.payload.code).toBe('STAFF_INACTIVE')
    // Caches the negative result so subsequent rejects skip DB.
    expect(cacheSet).toHaveBeenCalledWith(
      `bakaloo:staff-active:v1:${STAFF_USER_ID}:${SHOP_ID}`,
      false,
      300
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// requireShopScope — Super Admin (X-Shop-Id) branch
// ═══════════════════════════════════════════════════════════════
describe('requireShopScope — super admin', () => {
  it('allows admin with no X-Shop-Id and sets request.shopId = null', async () => {
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: ADMIN_USER_ID, role: 'ADMIN' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(req.shopId).toBeNull()
    expect(reply.statusCode).toBeNull()
  })

  it('attaches X-Shop-Id when admin provides a valid UUID for an active shop', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SHOP_ID }] })
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: ADMIN_USER_ID, role: 'ADMIN' },
      headers: { 'x-shop-id': SHOP_ID },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(req.shopId).toBe(SHOP_ID)
    expect(reply.statusCode).toBeNull()
  })

  it('rejects 400 INVALID_SHOP_ID when X-Shop-Id is not a UUID', async () => {
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: ADMIN_USER_ID, role: 'ADMIN' },
      headers: { 'x-shop-id': 'not-a-uuid' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(reply.statusCode).toBe(400)
    expect(reply.payload.code).toBe('INVALID_SHOP_ID')
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects 400 INVALID_SHOP_ID when X-Shop-Id refers to an unknown/inactive shop', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: ADMIN_USER_ID, role: 'ADMIN' },
      headers: { 'x-shop-id': SHOP_ID },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(reply.statusCode).toBe(400)
    expect(reply.payload.code).toBe('INVALID_SHOP_ID')
  })
})

// ═══════════════════════════════════════════════════════════════
// requireShopScope — Non-staff non-admin (customer/rider)
// ═══════════════════════════════════════════════════════════════
describe('requireShopScope — non-staff, non-admin', () => {
  it('sets request.shopId = null and allows by default', async () => {
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: STAFF_USER_ID, role: 'CUSTOMER' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(req.shopId).toBeNull()
    expect(reply.statusCode).toBeNull()
  })

  it('rejects 403 SHOP_SCOPE_REQUIRED when requireShop=true', async () => {
    const handler = requireShopScope({ requireShop: true })
    const req = makeRequest({
      user: { id: STAFF_USER_ID, role: 'CUSTOMER' },
    })
    const reply = makeReply()

    await handler(req, reply)
    expect(reply.statusCode).toBe(403)
    expect(reply.payload.code).toBe('SHOP_SCOPE_REQUIRED')
  })

  it('does not consult the DB or cache for customer/rider tokens', async () => {
    const handler = requireShopScope()
    const req = makeRequest({
      user: { id: STAFF_USER_ID, role: 'RIDER' },
    })
    await handler(req, makeReply())
    expect(query).not.toHaveBeenCalled()
    expect(cacheGet).not.toHaveBeenCalled()
  })
})
