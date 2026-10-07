import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing the SUT ─
// Mirror the convention used by the sibling allocation.service.test.js so the
// two files stay aligned.
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn() },
}))

import { AllocationController } from '../../../src/modules/allocation/allocation.controller.js'
import { ROLES } from '../../../src/constants/roles.js'

// ─── Helpers ─────────────────────────────────────────────
function createServiceMock() {
  return {
    getForUser: vi.fn(),
    computeAndUpsertForUser: vi.fn(),
  }
}

/**
 * Build a Fastify-style reply with chainable .code().send().
 * Mirrors tests/unit/shops/shops.controller.test.js.
 */
function createReplyMock() {
  const reply = {
    statusCode: 200,
    body: undefined,
    code: vi.fn(function (status) {
      this.statusCode = status
      return this
    }),
    send: vi.fn(function (payload) {
      this.body = payload
      return this
    }),
  }
  return reply
}

const USER_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222'
const SHOP_A = '33333333-3333-3333-3333-33333333333a'

const VALID_ADDRESS = { lat: 12.97, lng: 77.59, pincode: '560001' }

// ═══════════════════════════════════════════════════════════
// GET /my-shops — Requirement 4.5
// ═══════════════════════════════════════════════════════════
describe('AllocationController.myShops()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new AllocationController(service)
    reply = createReplyMock()
  })

  it('returns 401 UNAUTHORIZED when request is unauthenticated (no user)', async () => {
    await controller.myShops({ user: undefined }, reply)

    expect(service.getForUser).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(401)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'UNAUTHORIZED',
    })
  })

  it('returns 401 UNAUTHORIZED when JWT carries no user id', async () => {
    await controller.myShops({ user: {} }, reply)

    expect(service.getForUser).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(401)
    expect(reply.body.code).toBe('UNAUTHORIZED')
  })

  it('calls service.getForUser with the JWT user id and returns 200 success envelope', async () => {
    const payload = {
      shops: [
        {
          id: 'alloc-1',
          shop_id: SHOP_A,
          name: 'Fresh Mart',
          distance_km: 1.2,
          matched_pincode: '560001',
          is_primary: true,
        },
      ],
    }
    service.getForUser.mockResolvedValue(payload)

    await controller.myShops(
      { user: { id: USER_ID, role: ROLES.CUSTOMER } },
      reply
    )

    expect(service.getForUser).toHaveBeenCalledWith(USER_ID)
    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({
      success: true,
      message: 'Allocated shops fetched',
      data: payload,
    })
  })
})

// ═══════════════════════════════════════════════════════════
// POST /recompute — Requirements 4.1, 4.6
// ═══════════════════════════════════════════════════════════
describe('AllocationController.recompute()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new AllocationController(service)
    reply = createReplyMock()
  })

  it('returns 401 UNAUTHORIZED on unauthenticated request', async () => {
    await controller.recompute(
      { user: undefined, body: { address: VALID_ADDRESS } },
      reply
    )

    expect(service.computeAndUpsertForUser).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(401)
    expect(reply.body.code).toBe('UNAUTHORIZED')
  })

  it('allows non-admin to recompute their own allocations', async () => {
    service.computeAndUpsertForUser.mockResolvedValue({
      success: true,
      data: { shops: [] },
    })

    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.CUSTOMER },
        body: { address: VALID_ADDRESS },
      },
      reply
    )

    expect(service.computeAndUpsertForUser).toHaveBeenCalledWith(
      USER_ID,
      VALID_ADDRESS
    )
    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({
      success: true,
      message: 'Allocations recomputed',
    })
  })

  it('returns 403 FORBIDDEN when non-admin targets another user', async () => {
    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.CUSTOMER },
        body: { user_id: OTHER_USER_ID, address: VALID_ADDRESS },
      },
      reply
    )

    expect(service.computeAndUpsertForUser).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(403)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
    })
  })

  it('allows ADMIN to recompute on behalf of another user', async () => {
    service.computeAndUpsertForUser.mockResolvedValue({
      success: true,
      data: { shops: [] },
    })

    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.ADMIN },
        body: { user_id: OTHER_USER_ID, address: VALID_ADDRESS },
      },
      reply
    )

    expect(service.computeAndUpsertForUser).toHaveBeenCalledWith(
      OTHER_USER_ID,
      VALID_ADDRESS
    )
    expect(reply.code).toHaveBeenCalledWith(200)
  })

  it('returns 400 NO_COORDINATES when body has no address', async () => {
    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.CUSTOMER },
        body: {},
      },
      reply
    )

    expect(service.computeAndUpsertForUser).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'NO_COORDINATES',
    })
  })

  it('returns 400 VALIDATION_ERROR on malformed address (lat out of range)', async () => {
    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.CUSTOMER },
        body: { address: { lat: 999, lng: 77.59, pincode: '560001' } },
      },
      reply
    )

    expect(service.computeAndUpsertForUser).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })

  it('propagates NO_COORDINATES from service as 400', async () => {
    service.computeAndUpsertForUser.mockResolvedValue({
      success: false,
      code: 'NO_COORDINATES',
      message: 'A complete delivery address with coordinates is required',
    })

    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.CUSTOMER },
        body: { address: VALID_ADDRESS },
      },
      reply
    )

    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('NO_COORDINATES')
  })

  it('returns 200 success envelope when ADMIN with valid address triggers recompute', async () => {
    service.computeAndUpsertForUser.mockResolvedValue({
      success: true,
      data: { shops: [{ shop_id: SHOP_A, is_primary: true }] },
    })

    await controller.recompute(
      {
        user: { id: USER_ID, role: ROLES.ADMIN },
        body: { user_id: OTHER_USER_ID, address: VALID_ADDRESS },
      },
      reply
    )

    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({
      success: true,
      message: 'Allocations recomputed',
      data: { shops: [{ shop_id: SHOP_A, is_primary: true }] },
    })
  })
})
