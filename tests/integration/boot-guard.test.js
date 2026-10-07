/**
 * Task 23.11 — Boot-time guard: unknown permission string fails boot
 *
 * Scenario:
 *   1. Register a route with a `requiredPermission` string NOT in the
 *      canonical 37-string vocabulary (e.g. 'shop_products.nuke')
 *   2. Run the permission audit in strict mode
 *   3. Verify the audit returns `{ ok: false }` (which in production
 *      triggers `process.exit(1)`)
 *
 * This test exercises two layers of the boot-time guard:
 *
 *   A. The `requirePermission(perm)` factory in
 *      `src/middlewares/permission-check.js` — throws a TypeError
 *      synchronously when `perm` is not in CANONICAL_PERMISSIONS.
 *      This prevents the route from even registering.
 *
 *   B. The `runPermissionAudit()` function in
 *      `src/utils/permission-audit.js` — walks all collected routes
 *      after `app.ready()` and flags any protected route whose
 *      `config.requiredPermission` is not in the canonical vocabulary.
 *      In strict mode, returns `{ ok: false }` so the caller can
 *      `process.exit(1)`.
 *
 * Both paths ensure R17 AC#9: "SHALL fail the application boot with a
 * non-zero exit code if any protected route is registered without a
 * declared required permission or with a Permission_String value not
 * present in the canonical vocabulary."
 *
 * Requirements: R17.9
 * Design:       §4.5 of .kiro/specs/multi-vendor-system/design.md
 */

import { describe, expect, it, vi } from 'vitest'

// ─── Direct imports (no mocking needed for these pure utilities) ─────────────
import { requirePermission } from '../../src/middlewares/permission-check.js'
import {
  auditCollectedRoutes,
  installRouteCollector,
  runPermissionAudit,
} from '../../src/utils/permission-audit.js'
import { CANONICAL_PERMISSIONS } from '../../src/utils/permissions.js'

// ─── Mock audit-log (imported by permission-check.js) ───────────────────────
vi.mock('../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ═══════════════════════════════════════════════════════════════════════════════
// Layer A: requirePermission() factory throws on unknown permission string
// ═══════════════════════════════════════════════════════════════════════════════
describe('Task 23.11: Boot-time guard — requirePermission() rejects unknown strings', () => {
  it('throws TypeError for a permission string NOT in the canonical vocabulary', () => {
    const unknownPerm = 'shop_products.nuke'

    // Verify it's truly not in the vocabulary
    expect(CANONICAL_PERMISSIONS.has(unknownPerm)).toBe(false)

    // The factory must throw synchronously at boot time
    expect(() => requirePermission(unknownPerm)).toThrow(TypeError)
    expect(() => requirePermission(unknownPerm)).toThrow(
      /not in the canonical Permission_String vocabulary/
    )
  })

  it('throws TypeError for an empty string', () => {
    expect(() => requirePermission('')).toThrow(TypeError)
  })

  it('throws TypeError for a non-string value', () => {
    expect(() => requirePermission(null)).toThrow(TypeError)
    expect(() => requirePermission(undefined)).toThrow(TypeError)
    expect(() => requirePermission(42)).toThrow(TypeError)
  })

  it('succeeds for a valid canonical permission string', () => {
    const validPerm = 'shop_products.view'
    expect(CANONICAL_PERMISSIONS.has(validPerm)).toBe(true)

    const handler = requirePermission(validPerm)
    expect(typeof handler).toBe('function')
    expect(handler.requiredPermission).toBe(validPerm)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Layer B: auditCollectedRoutes() flags invalid permission declarations
// ═══════════════════════════════════════════════════════════════════════════════
describe('Task 23.11: Boot-time guard — auditCollectedRoutes() detects violations', () => {
  it('flags a protected route with a non-canonical requiredPermission as invalid', () => {
    const collectedRoutes = [
      {
        method: 'POST',
        url: '/api/v1/shop-products/nuke',
        preHandler: [],
        config: { requiredPermission: 'shop_products.nuke' },
      },
    ]

    const result = auditCollectedRoutes(collectedRoutes)

    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/shop-products/nuke',
      kind: 'invalid',
      declared: 'shop_products.nuke',
    })
    expect(result.protectedCount).toBe(1)
  })

  it('flags a protected route with missing requiredPermission', () => {
    const collectedRoutes = [
      {
        method: 'GET',
        url: '/api/v1/shops/list',
        preHandler: [],
        config: {},
      },
    ]

    const result = auditCollectedRoutes(collectedRoutes)

    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      method: 'GET',
      url: '/api/v1/shops/list',
      kind: 'missing',
    })
  })

  it('passes for a protected route with a valid canonical permission', () => {
    const collectedRoutes = [
      {
        method: 'GET',
        url: '/api/v1/shop-products/list',
        preHandler: [],
        config: { requiredPermission: 'shop_products.view' },
      },
    ]

    const result = auditCollectedRoutes(collectedRoutes)

    expect(result.violations).toHaveLength(0)
    expect(result.protectedCount).toBe(1)
  })

  it('does not flag unscoped (customer-facing) routes', () => {
    const collectedRoutes = [
      {
        method: 'GET',
        url: '/api/v1/cart',
        preHandler: [],
        config: {},
      },
      {
        method: 'GET',
        url: '/api/v1/products/featured',
        preHandler: [],
        config: {},
      },
    ]

    const result = auditCollectedRoutes(collectedRoutes)

    expect(result.violations).toHaveLength(0)
    expect(result.unscopedCount).toBe(2)
    expect(result.protectedCount).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Layer B: runPermissionAudit() in strict mode returns { ok: false }
// ═══════════════════════════════════════════════════════════════════════════════
describe('Task 23.11: Boot-time guard — runPermissionAudit() strict mode fails boot', () => {
  it('returns ok=false in strict mode when violations exist', () => {
    const collectedRoutes = [
      {
        method: 'DELETE',
        url: '/api/v1/admin/dangerous',
        preHandler: [],
        config: { requiredPermission: 'admin.destroy_everything' },
      },
    ]

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const result = runPermissionAudit({
      collectedRoutes,
      strict: true,
      logger: mockLogger,
    })

    // Boot should fail
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].kind).toBe('invalid')
    expect(result.violations[0].declared).toBe('admin.destroy_everything')

    // Error was logged
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
  })

  it('returns ok=true in non-strict mode even with violations (warns only)', () => {
    const collectedRoutes = [
      {
        method: 'POST',
        url: '/api/v1/shop-products/bad-route',
        preHandler: [],
        config: { requiredPermission: 'invalid.permission' },
      },
    ]

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const result = runPermissionAudit({
      collectedRoutes,
      strict: false,
      logger: mockLogger,
    })

    // Boot continues in non-strict mode
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(1)

    // Warning was logged (not error)
    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it('returns ok=true when all protected routes have valid permissions', () => {
    const collectedRoutes = [
      {
        method: 'GET',
        url: '/api/v1/shop-products/list',
        preHandler: [],
        config: { requiredPermission: 'shop_products.view' },
      },
      {
        method: 'POST',
        url: '/api/v1/shops/create',
        preHandler: [],
        config: { requiredPermission: 'shops.create' },
      },
    ]

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const result = runPermissionAudit({
      collectedRoutes,
      strict: true,
      logger: mockLogger,
    })

    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.protectedCount).toBe(2)

    // Info was logged (audit passed)
    expect(mockLogger.info).toHaveBeenCalledTimes(1)
  })

  it('detects permission declared on preHandler.requiredPermission property', () => {
    // Simulate a route where the permission is on the preHandler function
    // (set by requirePermission() factory) rather than in config
    const handler = requirePermission('shop_products.view')

    const collectedRoutes = [
      {
        method: 'GET',
        url: '/api/v1/shop-products/detail',
        preHandler: [handler],
        config: {},
      },
    ]

    const result = auditCollectedRoutes(collectedRoutes)

    expect(result.violations).toHaveLength(0)
    expect(result.protectedCount).toBe(1)
  })
})
