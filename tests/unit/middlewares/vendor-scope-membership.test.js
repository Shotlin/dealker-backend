/**
 * requireVendorScope — vendor staff membership resolution branch (Big Phase 4)
 *
 * Covers the OTP-login vendor app path: a non-platform user without JWT vendor
 * claims is scoped to their single active vendor_users membership, must select
 * a context when they hold several, and is rejected when they hold none.
 * Platform-user and JWT-claim behaviors are unchanged (owned by
 * tests/unit/middlewares/scope-middleware.test.js).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
}))
vi.mock('../../../src/config/database.js', () => ({
  query: databaseMock.query,
  pool: { query: databaseMock.query },
  getClient: vi.fn(),
}))

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDel: vi.fn(async () => undefined),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { findActiveVendorMemberships, requireVendorScope } from '../../../src/middlewares/vendor-scope.js'

function makeRequest({ user, headers = {}, params = {} }) {
  return { user, headers, params }
}

function makeReply() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    send(payload) {
      this.payload = payload
      return this
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockImplementation(async () => ({ rows: [] }))
})

describe('vendor staff membership resolution (no JWT vendor claim)', () => {
  const VENDOR_USER = { id: 'user-1', role: 'VENDOR_OWNER' }

  it('scopes a vendor staff user with exactly one active membership', async () => {
    databaseMock.query.mockImplementation(async (sql) => {
      if (/FROM vendor_users/.test(String(sql))) return { rows: [{ vendor_id: 'vendor-1' }] }
      return { rows: [] }
    })

    const middleware = requireVendorScope({ requireVendor: true })
    const req = makeRequest({ user: VENDOR_USER })
    const reply = makeReply()

    await middleware(req, reply)

    expect(req.vendorId).toBe('vendor-1')
    expect(reply.statusCode).toBeNull()
  })

  it('requires an explicit selection for multi-vendor staff', async () => {
    databaseMock.query.mockImplementation(async (sql) => {
      if (/FROM vendor_users/.test(String(sql))) {
        return { rows: [{ vendor_id: 'vendor-1' }, { vendor_id: 'vendor-2' }] }
      }
      return { rows: [] }
    })

    const middleware = requireVendorScope({ requireVendor: true })

    const withoutHeader = makeRequest({ user: VENDOR_USER })
    const replyNoHeader = makeReply()
    await middleware(withoutHeader, replyNoHeader)
    expect(replyNoHeader.statusCode).toBe(409)
    expect(replyNoHeader.payload.code).toBe('VENDOR_SELECTION_REQUIRED')

    const withHeader = makeRequest({ user: VENDOR_USER, headers: { 'x-vendor-id': 'vendor-2' } })
    const replyWithHeader = makeReply()
    await middleware(withHeader, replyWithHeader)
    expect(withHeader.vendorId).toBe('vendor-2')
    expect(replyWithHeader.statusCode).toBeNull()
  })

  it('rejects users with no vendor membership when requireVendor is set', async () => {
    const middleware = requireVendorScope({ requireVendor: true })
    const req = makeRequest({ user: { id: 'customer-1', role: 'CUSTOMER' } })
    const reply = makeReply()

    await middleware(req, reply)

    expect(req.vendorId).toBeNull()
    expect(reply.statusCode).toBe(403)
  })

  it('exports a membership resolver returning active vendor ids', async () => {
    databaseMock.query.mockImplementation(async () => ({ rows: [{ vendor_id: 'vendor-9' }] }))
    expect(await findActiveVendorMemberships('user-1')).toEqual(['vendor-9'])
  })
})
