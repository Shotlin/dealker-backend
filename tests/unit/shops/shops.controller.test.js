import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShopsController } from '../../../src/modules/shops/shops.controller.js'

// ─── Test Helpers ────────────────────────────────────────
function createServiceMock() {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

/**
 * Build a Fastify-style reply mock with chainable .code().send()
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

const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const USER_ID = '11111111-1111-1111-1111-111111111111'

const VALID_BODY = {
  name: 'Fresh Mart Indiranagar',
  address_line1: '100 Main Road',
  city: 'Bangalore',
  state: 'Karnataka',
  pincode: '560038',
  lat: 12.9716,
  lng: 77.5946,
}

const MOCK_SHOP = {
  id: SHOP_ID,
  name: 'Fresh Mart Indiranagar',
  slug: 'fresh-mart-indiranagar',
  branch_code: 'BAN001',
  city: 'Bangalore',
  is_active: true,
}

// ═══════════════════════════════════════════════════════════
// ShopsController.create() — Requirement 1.1, 1.8
// ═══════════════════════════════════════════════════════════
describe('ShopsController.create()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new ShopsController(service)
    reply = createReplyMock()
  })

  it('returns 201 with created shop on valid input', async () => {
    service.create.mockResolvedValue(MOCK_SHOP)

    await controller.create(
      { body: VALID_BODY, user: { id: USER_ID } },
      reply
    )

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: VALID_BODY.name }),
      USER_ID
    )
    expect(reply.code).toHaveBeenCalledWith(201)
    expect(reply.body).toEqual(
      expect.objectContaining({
        success: true,
        message: 'Shop created',
        data: MOCK_SHOP,
      })
    )
  })

  it('returns 400 with VALIDATION_ERROR when required fields are missing', async () => {
    await controller.create(
      { body: { name: '' }, user: { id: USER_ID } },
      reply
    )

    expect(service.create).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
    })
  })

  it('returns 400 when lat is out of range (> 90)', async () => {
    await controller.create(
      { body: { ...VALID_BODY, lat: 95 }, user: { id: USER_ID } },
      reply
    )

    expect(service.create).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when commission_rate is out of allowed range', async () => {
    await controller.create(
      { body: { ...VALID_BODY, commission_rate: 150 }, user: { id: USER_ID } },
      reply
    )

    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsController.list() — Requirement 1.6 (pagination)
// ═══════════════════════════════════════════════════════════
describe('ShopsController.list()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new ShopsController(service)
    reply = createReplyMock()
  })

  it('returns 200 with paginated structure { shops, total, page, limit }', async () => {
    service.list.mockResolvedValue({
      shops: [MOCK_SHOP],
      total: 1,
      page: 1,
      limit: 20,
    })

    await controller.list({ query: {} }, reply)

    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({
      success: true,
      data: {
        shops: [MOCK_SHOP],
        total: 1,
        page: 1,
        limit: 20,
      },
    })
  })

  it('coerces page and limit query strings to numbers and forwards to service', async () => {
    service.list.mockResolvedValue({ shops: [], total: 0, page: 3, limit: 50 })

    await controller.list({ query: { page: '3', limit: '50' } }, reply)

    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, limit: 50 })
    )
  })

  it('returns 400 when limit exceeds 100', async () => {
    await controller.list({ query: { limit: '500' } }, reply)

    expect(service.list).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when is_active is not "true"/"false"', async () => {
    await controller.list({ query: { is_active: 'maybe' } }, reply)

    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsController.getOne()
// ═══════════════════════════════════════════════════════════
describe('ShopsController.getOne()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new ShopsController(service)
    reply = createReplyMock()
  })

  it('returns 200 with shop on success', async () => {
    service.getById.mockResolvedValue(MOCK_SHOP)

    await controller.getOne({ params: { id: SHOP_ID } }, reply)

    expect(service.getById).toHaveBeenCalledWith(SHOP_ID)
    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({ success: true, data: MOCK_SHOP })
  })

  it('returns 404 with SHOP_NOT_FOUND when service returns null', async () => {
    service.getById.mockResolvedValue(null)

    await controller.getOne({ params: { id: SHOP_ID } }, reply)

    expect(reply.code).toHaveBeenCalledWith(404)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'SHOP_NOT_FOUND',
    })
  })

  it('returns 400 on non-UUID id parameter', async () => {
    await controller.getOne({ params: { id: 'not-a-uuid' } }, reply)

    expect(service.getById).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsController.update()
// ═══════════════════════════════════════════════════════════
describe('ShopsController.update()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new ShopsController(service)
    reply = createReplyMock()
  })

  it('returns 200 with updated shop on success', async () => {
    service.update.mockResolvedValue({ success: true, shop: MOCK_SHOP })

    await controller.update(
      {
        params: { id: SHOP_ID },
        body: { phone: '9999999999' },
        user: { id: USER_ID },
      },
      reply
    )

    expect(service.update).toHaveBeenCalledWith(
      SHOP_ID,
      { phone: '9999999999' },
      USER_ID,
      expect.anything()
    )
    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({ success: true, data: MOCK_SHOP })
  })

  it('returns 404 with SHOP_NOT_FOUND when service signals missing shop', async () => {
    service.update.mockResolvedValue({
      success: false,
      message: 'Shop not found',
      code: 'SHOP_NOT_FOUND',
    })

    await controller.update(
      {
        params: { id: SHOP_ID },
        body: { phone: '9999999999' },
        user: { id: USER_ID },
      },
      reply
    )

    expect(reply.code).toHaveBeenCalledWith(404)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'SHOP_NOT_FOUND',
    })
  })

  it('returns 400 on invalid id param', async () => {
    await controller.update(
      { params: { id: 'bad' }, body: {}, user: { id: USER_ID } },
      reply
    )

    expect(service.update).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 on invalid body (e.g. lng out of range)', async () => {
    await controller.update(
      {
        params: { id: SHOP_ID },
        body: { lng: 500 },
        user: { id: USER_ID },
      },
      reply
    )

    expect(service.update).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsController.delete()
// ═══════════════════════════════════════════════════════════
describe('ShopsController.delete()', () => {
  let service
  let controller
  let reply

  beforeEach(() => {
    vi.clearAllMocks()
    service = createServiceMock()
    controller = new ShopsController(service)
    reply = createReplyMock()
  })

  it('returns 200 with success payload on successful soft delete', async () => {
    service.delete.mockResolvedValue({ success: true })

    await controller.delete(
      { params: { id: SHOP_ID }, user: { id: USER_ID } },
      reply
    )

    expect(service.delete).toHaveBeenCalledWith(SHOP_ID, USER_ID)
    expect(reply.code).toHaveBeenCalledWith(200)
    expect(reply.body).toMatchObject({
      success: true,
      message: 'Shop deleted successfully',
    })
  })

  it('returns 404 with SHOP_NOT_FOUND when shop is missing', async () => {
    service.delete.mockResolvedValue({
      success: false,
      message: 'Shop not found',
      code: 'SHOP_NOT_FOUND',
    })

    await controller.delete(
      { params: { id: SHOP_ID }, user: { id: USER_ID } },
      reply
    )

    expect(reply.code).toHaveBeenCalledWith(404)
    expect(reply.body).toMatchObject({
      success: false,
      code: 'SHOP_NOT_FOUND',
    })
  })

  it('returns 400 on non-UUID id param', async () => {
    await controller.delete(
      { params: { id: '123' }, user: { id: USER_ID } },
      reply
    )

    expect(service.delete).not.toHaveBeenCalled()
    expect(reply.code).toHaveBeenCalledWith(400)
    expect(reply.body.code).toBe('VALIDATION_ERROR')
  })
})
