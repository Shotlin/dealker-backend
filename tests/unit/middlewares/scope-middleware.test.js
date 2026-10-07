import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock database query BEFORE importing middlewares
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/config/database.js', () => ({
  query: queryMock,
}))

// Mock cache utility
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}))

// Mock logger
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  extractVendorId,
  requireVendorScope,
  assertVendorMatch,
  isPlatformUser,
} from '../../../src/middlewares/vendor-scope.js'

import {
  extractWarehouseId,
  requireWarehouseScope,
  assertWarehouseMatch,
} from '../../../src/middlewares/warehouse-scope.js'

describe('Phase 1D Scope Middleware Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─── Vendor Scope Middleware Tests ─────────────────────────────────
  describe('Vendor Scope Middleware', () => {
    const VALID_UUID = '11111111-1111-1111-1111-111111111111'
    const ANOTHER_UUID = '22222222-2222-2222-2222-222222222222'

    it('extracts vendorId from JWT, header, or route params correctly', () => {
      expect(extractVendorId({ user: { vendorId: VALID_UUID } })).toEqual({
        vendorId: VALID_UUID,
        source: 'jwt',
      })

      expect(extractVendorId({ headers: { 'x-vendor-id': ANOTHER_UUID } })).toEqual({
        vendorId: ANOTHER_UUID,
        source: 'header',
      })

      expect(extractVendorId({ params: { vendorId: VALID_UUID } })).toEqual({
        vendorId: VALID_UUID,
        source: 'path',
      })
    })

    it('rejects unauthenticated requests with HTTP 401 UNAUTHORIZED', async () => {
      const middleware = requireVendorScope()
      const req = {}
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      }

      await middleware(req, reply)

      expect(reply.status).toHaveBeenCalledWith(401)
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'UNAUTHORIZED' })
      )
    })

    it('attaches vendorId for valid active vendor staff JWT', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'vu-1' }] })

      const middleware = requireVendorScope()
      const req = { user: { id: 'u-1', vendorId: VALID_UUID } }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(req.vendorId).toBe(VALID_UUID)
      expect(reply.status).not.toHaveBeenCalled()
    })

    it('rejects inactive vendor staff with HTTP 403 STAFF_INACTIVE', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }) // Inactive staff DB response

      const middleware = requireVendorScope()
      const req = { user: { id: 'u-1', vendorId: VALID_UUID } }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(reply.status).toHaveBeenCalledWith(403)
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'STAFF_INACTIVE' })
      )
    })

    it('allows admin users with valid X-Vendor-Id header', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] })

      const middleware = requireVendorScope()
      const req = {
        user: { id: 'u-admin', role: 'ADMIN' },
        headers: { 'x-vendor-id': VALID_UUID },
      }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(req.vendorId).toBe(VALID_UUID)
    })

    it('rejects malformed X-Vendor-Id header for admin with HTTP 400', async () => {
      const middleware = requireVendorScope()
      const req = {
        user: { id: 'u-admin', role: 'ADMIN' },
        headers: { 'x-vendor-id': 'invalid-uuid-string' },
      }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(reply.status).toHaveBeenCalledWith(400)
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_VENDOR_ID' })
      )
    })

    it('rejects unknown vendor in X-Vendor-Id header with HTTP 404 VENDOR_NOT_FOUND', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }) // Unknown vendor DB response

      const middleware = requireVendorScope()
      const req = {
        user: { id: 'u-admin', role: 'ADMIN' },
        headers: { 'x-vendor-id': VALID_UUID },
      }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(reply.status).toHaveBeenCalledWith(404)
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'VENDOR_NOT_FOUND' })
      )
    })

    it('asserts vendor scope match correctly', () => {
      // Super admin always passes
      expect(assertVendorMatch({ role: 'SUPER_ADMIN', callerVendorId: 'v1', resourceVendorId: 'v2' })).toEqual({ allowed: true })

      // Matching vendor passes
      expect(assertVendorMatch({ role: 'VENDOR_OWNER', callerVendorId: 'v1', resourceVendorId: 'v1' })).toEqual({ allowed: true })

      // Mismatched vendor fails 403
      expect(assertVendorMatch({ role: 'VENDOR_OWNER', callerVendorId: 'v1', resourceVendorId: 'v2' })).toEqual({
        allowed: false,
        status: 403,
        code: 'CROSS_SHOP_ACCESS_DENIED',
        message: expect.stringContaining('Forbidden'),
      })
    })
  })

  // ─── Warehouse Scope Middleware Tests ──────────────────────────────
  describe('Warehouse Scope Middleware', () => {
    const VALID_UUID = '33333333-3333-3333-3333-333333333333'
    const ANOTHER_UUID = '44444444-4444-4444-4444-444444444444'

    it('extracts warehouseId from JWT, header, or route params correctly', () => {
      expect(extractWarehouseId({ user: { warehouseId: VALID_UUID } })).toEqual({
        warehouseId: VALID_UUID,
        source: 'jwt',
      })

      expect(extractWarehouseId({ headers: { 'x-warehouse-id': ANOTHER_UUID } })).toEqual({
        warehouseId: ANOTHER_UUID,
        source: 'header',
      })
    })

    it('rejects unauthenticated requests with HTTP 401 UNAUTHORIZED', async () => {
      const middleware = requireWarehouseScope()
      const req = {}
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(reply.status).toHaveBeenCalledWith(401)
    })

    it('attaches warehouseId for valid active warehouse JWT', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] })

      const middleware = requireWarehouseScope()
      const req = { user: { id: 'u-wh', warehouseId: VALID_UUID } }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(req.warehouseId).toBe(VALID_UUID)
    })

    it('rejects inactive warehouse with HTTP 403', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }) // Inactive warehouse DB response

      const middleware = requireWarehouseScope()
      const req = { user: { id: 'u-wh', warehouseId: VALID_UUID } }
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }

      await middleware(req, reply)

      expect(reply.status).toHaveBeenCalledWith(403)
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CROSS_SHOP_ACCESS_DENIED' })
      )
    })

    it('asserts warehouse scope match correctly', () => {
      expect(assertWarehouseMatch({ role: 'ADMIN', callerWarehouseId: 'w1', resourceWarehouseId: 'w2' })).toEqual({ allowed: true })
      expect(assertWarehouseMatch({ role: 'WAREHOUSE_RECEIVER', callerWarehouseId: 'w1', resourceWarehouseId: 'w1' })).toEqual({ allowed: true })
      expect(assertWarehouseMatch({ role: 'WAREHOUSE_RECEIVER', callerWarehouseId: 'w1', resourceWarehouseId: 'w2' })).toEqual({
        allowed: false,
        status: 403,
        code: 'CROSS_SHOP_ACCESS_DENIED',
        message: expect.stringContaining('Forbidden'),
      })
    })
  })
})
