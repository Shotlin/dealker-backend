/**
 * Unit tests for the boot-time permission audit (task 2.7, R17 AC#9).
 *
 * Validates: Requirements 17.9
 * Design:    §4.5 of .kiro/specs/multi-vendor-system/design.md
 *
 * These tests exercise the pure helpers exported from
 * `src/utils/permission-audit.js` directly — no Fastify boot is required
 * since `auditCollectedRoutes` operates on a plain array of route
 * descriptors and `runPermissionAudit` accepts an injected logger.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  auditCollectedRoutes,
  runPermissionAudit,
} from '../../src/utils/permission-audit.js'
import { CANONICAL_PERMISSIONS } from '../../src/utils/permissions.js'

/**
 * Build a fake captured route — only the four fields the audit reads are
 * required, but each test specifies just what it needs.
 */
function route(overrides) {
  return {
    method: 'GET',
    url: '/',
    preHandler: undefined,
    config: {},
    ...overrides,
  }
}

/**
 * Build a fake preHandler function that mimics the shape produced by
 * `requirePermission(perm)` in `src/middlewares/permission-check.js` —
 * a function with a `requiredPermission` own property.
 */
function fakePreHandlerWith(perm) {
  const fn = async () => {}
  Object.defineProperty(fn, 'requiredPermission', { value: perm, enumerable: true })
  return fn
}

describe('auditCollectedRoutes', () => {
  it('returns no violations for an empty route table', () => {
    const result = auditCollectedRoutes([])
    expect(result.violations).toEqual([])
    expect(result.protectedCount).toBe(0)
    expect(result.totalCount).toBe(0)
  })

  it('classifies customer-facing routes as unscoped (not subject to R17 AC#9)', () => {
    const result = auditCollectedRoutes([
      route({ method: 'GET', url: '/api/v1/cart' }),
      route({ method: 'POST', url: '/api/v1/orders' }),
      route({ method: 'GET', url: '/api/v1/products' }),
      route({ method: 'GET', url: '/health' }),
    ])
    expect(result.violations).toEqual([])
    expect(result.unscopedCount).toBe(4)
    expect(result.protectedCount).toBe(0)
  })

  it('exempts the dashboard auth flow paths from the audit', () => {
    const result = auditCollectedRoutes([
      route({ method: 'POST', url: '/api/v1/admin/auth/login' }),
      route({ method: 'GET', url: '/api/v1/admin/auth/me' }),
      route({ method: 'POST', url: '/api/v1/admin/auth/logout' }),
      route({ method: 'POST', url: '/api/v1/admin/auth/select-shop' }),
      route({ method: 'POST', url: '/api/v1/admin/auth/change-password' }),
    ])
    expect(result.violations).toEqual([])
    expect(result.exemptCount).toBe(5)
    expect(result.protectedCount).toBe(0)
  })

  it('exempts a route whose config.publicRoute === true regardless of URL', () => {
    const result = auditCollectedRoutes([
      route({
        method: 'GET',
        url: '/api/v1/admin/orders',
        config: { publicRoute: true },
      }),
    ])
    expect(result.violations).toEqual([])
    expect(result.exemptCount).toBe(1)
  })

  it('flags a protected route with no requiredPermission as missing', () => {
    const result = auditCollectedRoutes([
      route({ method: 'GET', url: '/api/v1/admin/orders' }),
    ])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toEqual({
      method: 'GET',
      url: '/api/v1/admin/orders',
      kind: 'missing',
    })
    expect(result.protectedCount).toBe(1)
  })

  it('flags a protected route with a non-canonical requiredPermission as invalid', () => {
    const result = auditCollectedRoutes([
      route({
        method: 'POST',
        url: '/api/v1/shop-products',
        config: { requiredPermission: 'shops.read' }, // legacy alias, NOT canonical
      }),
    ])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toEqual({
      method: 'POST',
      url: '/api/v1/shop-products',
      kind: 'invalid',
      declared: 'shops.read',
    })
  })

  it('accepts a canonical Permission_String declared via config.requiredPermission', () => {
    const canonical = 'shops.view'
    expect(CANONICAL_PERMISSIONS.has(canonical)).toBe(true)
    const result = auditCollectedRoutes([
      route({
        method: 'GET',
        url: '/api/v1/shops/123',
        config: { requiredPermission: canonical },
      }),
    ])
    expect(result.violations).toEqual([])
    expect(result.protectedCount).toBe(1)
  })

  it('accepts a canonical Permission_String attached via preHandler.requiredPermission', () => {
    const ph = fakePreHandlerWith('shop_orders.view')
    const result = auditCollectedRoutes([
      route({
        method: 'GET',
        url: '/api/v1/shop-orders',
        preHandler: [async () => {}, ph],
      }),
    ])
    expect(result.violations).toEqual([])
    expect(result.protectedCount).toBe(1)
  })

  it('accepts a canonical Permission_String when preHandler is a single function (not array)', () => {
    const ph = fakePreHandlerWith('shop_products.update')
    const result = auditCollectedRoutes([
      route({
        method: 'PATCH',
        url: '/api/v1/shop-products/abc',
        preHandler: ph,
      }),
    ])
    expect(result.violations).toEqual([])
  })

  it('prefers config.requiredPermission over preHandler when both present', () => {
    // config carries a canonical string; preHandler carries an invalid one.
    // The audit should accept the route because config wins.
    const ph = fakePreHandlerWith('garbage.permission')
    const result = auditCollectedRoutes([
      route({
        method: 'GET',
        url: '/api/v1/admin/finance/shops',
        config: { requiredPermission: 'finance.global_view' },
        preHandler: ph,
      }),
    ])
    expect(result.violations).toEqual([])
  })

  it('aggregates multiple violations across many routes', () => {
    const result = auditCollectedRoutes([
      route({ method: 'GET', url: '/api/v1/admin/orders' }), // missing
      route({
        method: 'GET',
        url: '/api/v1/shop-financials',
        config: { requiredPermission: 'totally.fake' },
      }), // invalid
      route({
        method: 'GET',
        url: '/api/v1/shop-products',
        config: { requiredPermission: 'shop_products.view' },
      }), // OK
      route({ method: 'GET', url: '/api/v1/cart' }), // unscoped — ignored
    ])
    expect(result.violations).toHaveLength(2)
    expect(result.violations[0].kind).toBe('missing')
    expect(result.violations[1].kind).toBe('invalid')
    expect(result.protectedCount).toBe(3)
    expect(result.unscopedCount).toBe(1)
  })
})

describe('runPermissionAudit', () => {
  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('logs info and returns ok=true when there are no violations', () => {
    const logger = makeLogger()
    const result = runPermissionAudit({
      collectedRoutes: [
        route({
          method: 'GET',
          url: '/api/v1/shops',
          config: { requiredPermission: 'shops.view' },
        }),
      ],
      strict: true,
      logger,
    })
    expect(result.ok).toBe(true)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs error and returns ok=false in strict mode when violations exist', () => {
    const logger = makeLogger()
    const result = runPermissionAudit({
      collectedRoutes: [route({ method: 'GET', url: '/api/v1/admin/orders' })],
      strict: true,
      logger,
    })
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs warn and returns ok=true in non-strict mode when violations exist', () => {
    const logger = makeLogger()
    const result = runPermissionAudit({
      collectedRoutes: [route({ method: 'GET', url: '/api/v1/admin/orders' })],
      strict: false,
      logger,
    })
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('caps the warn-mode violation echo at 50 entries while reporting full count', () => {
    const logger = makeLogger()
    const many = []
    for (let i = 0; i < 75; i++) {
      many.push(route({ method: 'GET', url: `/api/v1/admin/orders/${i}` }))
    }
    const result = runPermissionAudit({
      collectedRoutes: many,
      strict: false,
      logger,
    })
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(75)
    const [logArg] = logger.warn.mock.calls[0]
    expect(logArg.violations).toHaveLength(50)
    expect(logArg.violationCount).toBe(75)
  })
})
