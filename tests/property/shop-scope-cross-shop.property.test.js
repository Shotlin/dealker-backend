// Feature: multi-vendor-system, Property 17: Cross-Shop Access Rejection
// **Validates: Requirements R17.5**
//
// Property:
//   For any non-admin request where the JWT shop_id differs from the resource's
//   shop_id, the platform must reject with HTTP 403 and code
//   CROSS_SHOP_ACCESS_DENIED (R17 AC#5). When they match, OR the caller is an
//   HQ_User (role === 'ADMIN'), the request must pass.
//
//   The legacy alias ERROR_CODES.SHOP_SCOPE_MISMATCH continues to resolve to
//   the same string value so older callers are unaffected.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock external dependencies BEFORE importing middleware ──
// The cross-shop check is a pure decision: no DB, no Redis. We mock these
// only so the module imports cleanly without a live infrastructure.
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

import {
  assertShopMatch,
  requireShopMatch,
} from '../../src/middlewares/shop-scope.js'
import { ROLES } from '../../src/constants/roles.js'

// ─── Arbitraries ────────────────────────────────────────────
// UUID v4 generator — uses fast-check's built-in uuid, which produces RFC 4122
// strings. Two independently-drawn UUIDs are statistically guaranteed to
// differ, but we additionally filter to enforce the precondition.
const uuidArb = fc.uuid()

const distinctUuidPairArb = fc
  .tuple(uuidArb, uuidArb)
  .filter(([a, b]) => a !== b)

// Non-admin platform roles. Staff carry the CUSTOMER platform role until
// they select a shop, but RIDER and any future role must also be rejected
// when shop_ids mismatch. ROLES.ADMIN is excluded here intentionally; it is
// covered by a dedicated property below.
const nonAdminRoleArb = fc.constantFrom('CUSTOMER', 'RIDER', 'SHOP_STAFF')

// ─── Helpers ────────────────────────────────────────────────
function makeRequest({ user, shopId = undefined } = {}) {
  return {
    user,
    shopId,
    headers: {},
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
// Property 17 — Pure decision (assertShopMatch)
// ═══════════════════════════════════════════════════════════════
describe('Property 17: Cross-Shop Access Rejection — assertShopMatch', () => {
  it('rejects every non-admin request where jwtShopId !== resourceShopId with 403 CROSS_SHOP_ACCESS_DENIED', () => {
    fc.assert(
      fc.property(
        nonAdminRoleArb,
        distinctUuidPairArb,
        (role, [jwtShopId, resourceShopId]) => {
          const decision = assertShopMatch({
            role,
            jwtShopId,
            resourceShopId,
          })
          expect(decision.allowed).toBe(false)
          expect(decision.status).toBe(403)
          expect(decision.code).toBe('CROSS_SHOP_ACCESS_DENIED')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('rejects every non-admin request whose JWT carries no shop_id with 403 CROSS_SHOP_ACCESS_DENIED', () => {
    fc.assert(
      fc.property(
        nonAdminRoleArb,
        uuidArb,
        fc.constantFrom(null, undefined, ''),
        (role, resourceShopId, jwtShopId) => {
          const decision = assertShopMatch({
            role,
            jwtShopId,
            resourceShopId,
          })
          expect(decision.allowed).toBe(false)
          expect(decision.status).toBe(403)
          expect(decision.code).toBe('CROSS_SHOP_ACCESS_DENIED')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('admits every non-admin request where jwtShopId === resourceShopId', () => {
    fc.assert(
      fc.property(nonAdminRoleArb, uuidArb, (role, shopId) => {
        const decision = assertShopMatch({
          role,
          jwtShopId: shopId,
          resourceShopId: shopId,
        })
        expect(decision.allowed).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  it('admits every Super Admin request regardless of shop_id pairing', () => {
    fc.assert(
      fc.property(
        // Either matching or mismatching pairs — admin must pass either way.
        fc.tuple(uuidArb, uuidArb),
        ([jwtShopId, resourceShopId]) => {
          const decision = assertShopMatch({
            role: ROLES.ADMIN,
            jwtShopId,
            resourceShopId,
          })
          expect(decision.allowed).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('admits Super Admins even when no shop scope or resource is supplied', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        fc.constantFrom(null, undefined),
        (jwtShopId, resourceShopId) => {
          const decision = assertShopMatch({
            role: ROLES.ADMIN,
            jwtShopId,
            resourceShopId,
          })
          expect(decision.allowed).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 17 — Fastify preHandler integration (requireShopMatch)
// ═══════════════════════════════════════════════════════════════
describe('Property 17: Cross-Shop Access Rejection — requireShopMatch', () => {
  it('non-admin: jwtShopId !== resourceShopId → reply.code(403) CROSS_SHOP_ACCESS_DENIED', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        uuidArb, // userId
        distinctUuidPairArb,
        async (role, userId, [jwtShopId, resourceShopId]) => {
          const handler = requireShopMatch(() => resourceShopId)
          const req = makeRequest({
            user: { id: userId, role, shopId: jwtShopId },
            shopId: jwtShopId,
          })
          const reply = makeReply()

          await handler(req, reply)

          expect(reply.statusCode).toBe(403)
          expect(reply.payload).toBeTruthy()
          expect(reply.payload.success).toBe(false)
          expect(reply.payload.code).toBe('CROSS_SHOP_ACCESS_DENIED')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('non-admin: jwtShopId === resourceShopId → request passes (no reply sent)', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        uuidArb, // userId
        uuidArb, // shopId (same on both sides)
        async (role, userId, shopId) => {
          const handler = requireShopMatch(() => shopId)
          const req = makeRequest({
            user: { id: userId, role, shopId },
            shopId,
          })
          const reply = makeReply()

          await handler(req, reply)

          expect(reply.statusCode).toBeNull()
          expect(reply.payload).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('Super Admin: any shop_id pairing → request passes', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb, // adminUserId
        // Mix of matching and mismatching pairs — both must be allowed.
        fc.tuple(
          fc.option(uuidArb, { nil: null }),
          fc.option(uuidArb, { nil: null })
        ),
        async (adminUserId, [jwtShopId, resourceShopId]) => {
          const handler = requireShopMatch(() => resourceShopId)
          const req = makeRequest({
            user: { id: adminUserId, role: ROLES.ADMIN, shopId: jwtShopId },
            shopId: jwtShopId,
          })
          const reply = makeReply()

          await handler(req, reply)

          expect(reply.statusCode).toBeNull()
          expect(reply.payload).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('non-admin without JWT shop scope but resource is shop-owned → 403 CROSS_SHOP_ACCESS_DENIED', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        uuidArb, // userId
        uuidArb, // resourceShopId
        async (role, userId, resourceShopId) => {
          const handler = requireShopMatch(() => resourceShopId)
          // No shopId in JWT — typical of a customer / rider token.
          const req = makeRequest({
            user: { id: userId, role },
            shopId: null,
          })
          const reply = makeReply()

          await handler(req, reply)

          expect(reply.statusCode).toBe(403)
          expect(reply.payload.code).toBe('CROSS_SHOP_ACCESS_DENIED')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
    await fc.assert(
      fc.asyncProperty(uuidArb, async (resourceShopId) => {
        const handler = requireShopMatch(() => resourceShopId)
        const req = makeRequest({ user: null })
        const reply = makeReply()

        await handler(req, reply)

        expect(reply.statusCode).toBe(401)
        expect(reply.payload.code).toBe('UNAUTHORIZED')
      }),
      { numRuns: 50 }
    )
  })
})
