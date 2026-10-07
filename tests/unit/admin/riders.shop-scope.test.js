import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage for the 2026-09-28 shop-scoped Rider Management
// feature: a store/shop manager can now see, search for, and assign
// riders to their OWN shop without HQ having to do it for them — see
// riders.routes.js's own doc comment for the full authorization model.
// This file covers the repository (real SQL shape) and service
// (shop-scoping/normalisation logic) layers; riders.authorization.test.js
// covers the pure allow/deny decisions.

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))
vi.mock('../../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))
vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
}))

const queryMock = vi.fn(async () => ({ rows: [] }))
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))
vi.mock('../../../src/config/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}))

const { AdminRidersRepository } = await import(
  '../../../src/modules/admin/riders/riders.repository.js'
)
const { AdminRidersService } = await import(
  '../../../src/modules/admin/riders/riders.service.js'
)
const { AdminRidersController } = await import(
  '../../../src/modules/admin/riders/riders.controller.js'
)
const { logAdminActivity } = await import('../../../src/utils/activityLogger.js')

function stubRepo(methods) {
  const originals = {}
  for (const [name, impl] of Object.entries(methods)) {
    originals[name] = AdminRidersRepository.prototype[name]
    AdminRidersRepository.prototype[name] = impl
  }
  return function restore() {
    for (const [name, original] of Object.entries(originals)) {
      AdminRidersRepository.prototype[name] = original
    }
  }
}

function stubService(methods) {
  const originals = {}
  for (const [name, impl] of Object.entries(methods)) {
    originals[name] = AdminRidersService.prototype[name]
    AdminRidersService.prototype[name] = impl
  }
  return function restore() {
    for (const [name, original] of Object.entries(originals)) {
      AdminRidersService.prototype[name] = original
    }
  }
}

function fakeReply() {
  const reply = {}
  reply.code = vi.fn().mockReturnValue(reply)
  reply.send = vi.fn().mockReturnValue(reply)
  return reply
}

beforeEach(() => {
  queryMock.mockClear()
  // findAll issues a SELECT then a COUNT; default both to an empty-but-
  // well-shaped result so tests that don't care about the exact rows
  // (most of them) don't have to stub a second resolution just to avoid
  // `countRes.rows[0].total` blowing up on `undefined`.
  queryMock.mockImplementation(async () => ({ rows: [{ total: 0 }] }))
})

// ─── Repository: findAll shop-scoping ───

describe('AdminRidersRepository.findAll shop scoping', () => {
  it('with no shopId, keeps the original unscoped roster query', async () => {
    const repo = new AdminRidersRepository()
    await repo.findAll({ offset: 0, limit: 20 })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).not.toContain('rider_store_assignments')
    expect(params).toEqual([20, 0])
  })

  it('with a shopId, filters to riders holding an active assignment for that shop', async () => {
    const repo = new AdminRidersRepository()
    await repo.findAll({ offset: 0, limit: 20, shopId: 'shop-kolkata' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('rider_store_assignments rsa')
    expect(sql).toContain('rsa.shop_id = $1')
    expect(sql).toContain('rsa.is_active = true')
    expect(params[0]).toBe('shop-kolkata')
  })

  it('combines shopId with a search term without breaking parameter indices', async () => {
    const repo = new AdminRidersRepository()
    await repo.findAll({ offset: 5, limit: 10, shopId: 'shop-1', search: 'ravi' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('rsa.shop_id = $1')
    expect(sql).toContain('$2')
    expect(params).toEqual(['shop-1', '%ravi%', 10, 5])
  })

  it('the COUNT query also applies the shop filter with matching params', async () => {
    const repo = new AdminRidersRepository()
    await repo.findAll({ offset: 0, limit: 20, shopId: 'shop-1' })

    const [countSql, countParams] = queryMock.mock.calls[1]
    expect(countSql).toContain('rider_store_assignments')
    expect(countParams).toEqual(['shop-1'])
  })
})

// ─── Repository: hasActiveAssignment / findByPhone / setSingleAssignment ───

describe('AdminRidersRepository.hasActiveAssignment', () => {
  it('true when a matching active row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    const repo = new AdminRidersRepository()
    expect(await repo.hasActiveAssignment('rider-1', 'shop-1')).toBe(true)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('is_active = true')
    expect(params).toEqual(['rider-1', 'shop-1'])
  })

  it('false when no row matches', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new AdminRidersRepository()
    expect(await repo.hasActiveAssignment('rider-1', 'shop-2')).toBe(false)
  })
})

describe('AdminRidersRepository.findByPhone', () => {
  it('matches both the bare and 91-prefixed digit forms', async () => {
    const repo = new AdminRidersRepository()
    await repo.findByPhone('9700000001')
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain("IN ($1, '91' || $1::text)")
    expect(params).toEqual(['9700000001'])
  })

  it('returns null when nothing matches', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new AdminRidersRepository()
    expect(await repo.findByPhone('0000000000')).toBeNull()
  })
})

describe('AdminRidersRepository.setSingleAssignment', () => {
  it('upserts exactly the one (rider, shop) row and never touches others', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'a1', rider_id: 'rider-1', shop_id: 'shop-1', is_active: true }],
    })
    const repo = new AdminRidersRepository()
    const row = await repo.setSingleAssignment('rider-1', 'shop-1', true)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (rider_id, shop_id)')
    expect(sql).not.toContain('shop_id = ANY')
    expect(params).toEqual(['rider-1', 'shop-1', true])
    expect(row.is_active).toBe(true)
  })
})

// ─── Service: list shop-scoping ───

describe('AdminRidersService.list', () => {
  it('passes shopId through to the repository', async () => {
    const findAll = vi.fn().mockResolvedValue({ riders: [], total: 0 })
    const restore = stubRepo({ findAll })
    try {
      const service = new AdminRidersService()
      await service.list({ page: 1, limit: 20, shopId: 'shop-1' })
      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ shopId: 'shop-1', offset: 0, limit: 20 })
      )
    } finally {
      restore()
    }
  })
})

// ─── Service: searchByPhone ───

describe('AdminRidersService.searchByPhone', () => {
  it('returns null when the phone is empty/unusable', async () => {
    const service = new AdminRidersService()
    expect(await service.searchByPhone('', 'shop-1')).toBeNull()
    expect(await service.searchByPhone(undefined, 'shop-1')).toBeNull()
  })

  it('returns null when no rider matches', async () => {
    const restore = stubRepo({ findByPhone: async () => null })
    try {
      const service = new AdminRidersService()
      expect(await service.searchByPhone('9700000099', 'shop-1')).toBeNull()
    } finally {
      restore()
    }
  })

  it('normalises a 91-prefixed number before searching', async () => {
    const findByPhone = vi.fn().mockResolvedValue({ id: 'rider-1', phone: '9700000001' })
    const restore = stubRepo({ findByPhone, hasActiveAssignment: async () => false })
    try {
      const service = new AdminRidersService()
      await service.searchByPhone('919700000001', 'shop-1')
      expect(findByPhone).toHaveBeenCalledWith('9700000001')
    } finally {
      restore()
    }
  })

  it('reports assigned_to_my_shop:true when the shop-scoped caller already owns this rider', async () => {
    const restore = stubRepo({
      findByPhone: async () => ({ id: 'rider-1', phone: '9700000001' }),
      hasActiveAssignment: async () => true,
    })
    try {
      const service = new AdminRidersService()
      const result = await service.searchByPhone('9700000001', 'shop-1')
      expect(result.assigned_to_my_shop).toBe(true)
    } finally {
      restore()
    }
  })

  it('reports assigned_to_my_shop:null for an HQ (no-shop) caller — the field is meaningless without a shop', async () => {
    const restore = stubRepo({
      findByPhone: async () => ({ id: 'rider-1', phone: '9700000001' }),
    })
    try {
      const service = new AdminRidersService()
      const result = await service.searchByPhone('9700000001', null)
      expect(result.assigned_to_my_shop).toBeNull()
    } finally {
      restore()
    }
  })
})

// ─── Service: setMyShopAssignment ───

describe('AdminRidersService.setMyShopAssignment', () => {
  it('returns null when the rider does not exist', async () => {
    const restore = stubRepo({ riderExists: async () => false })
    try {
      const service = new AdminRidersService()
      expect(await service.setMyShopAssignment('rider-x', 'shop-1', true, 'user-1')).toBeNull()
    } finally {
      restore()
    }
  })

  it('assigns, logs admin activity, and queues a backlog scan on activation', async () => {
    const setSingleAssignment = vi.fn().mockResolvedValue({
      id: 'a1', rider_id: 'rider-1', shop_id: 'shop-1', is_active: true,
    })
    const restore = stubRepo({ riderExists: async () => true, setSingleAssignment })
    try {
      const service = new AdminRidersService()
      const result = await service.setMyShopAssignment('rider-1', 'shop-1', true, 'user-1', '1.2.3.4')
      expect(setSingleAssignment).toHaveBeenCalledWith('rider-1', 'shop-1', true)
      expect(result.is_active).toBe(true)
      expect(logAdminActivity).toHaveBeenCalledWith(
        'user-1', 'ASSIGN_RIDER_TO_SHOP', 'rider', 'rider-1', null,
        { shopId: 'shop-1', active: true }, '1.2.3.4'
      )
    } finally {
      restore()
    }
  })

  it('unassigning does not queue a backlog scan', async () => {
    const { orderQueue } = await import('../../../src/config/bullmq.js')
    orderQueue.add.mockClear()
    const restore = stubRepo({
      riderExists: async () => true,
      setSingleAssignment: async () => ({ id: 'a1', is_active: false }),
    })
    try {
      const service = new AdminRidersService()
      await service.setMyShopAssignment('rider-1', 'shop-1', false, 'user-1')
      expect(orderQueue.add).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

// ─── Controller: shop-scope wiring ───

describe('AdminRidersController shop-scope wiring', () => {
  it('list forwards request.shopId to the service (null when unset, unaffected for HQ)', async () => {
    const list = vi.fn().mockResolvedValue({ riders: [], total: 0 })
    const restore = stubService({ list })
    try {
      const controller = new AdminRidersController()
      await controller.list({ query: {}, shopId: 'shop-1' }, fakeReply())
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-1' }))

      await controller.list({ query: {} }, fakeReply())
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ shopId: null }))
    } finally {
      restore()
    }
  })

  it('getLiveLocations uses the caller\'s OWN shop scope, ignoring a spoofed query shopId', async () => {
    const getLiveLocations = vi.fn().mockResolvedValue([])
    const restore = stubService({ getLiveLocations })
    try {
      const controller = new AdminRidersController()
      // A shop-scoped caller (request.shopId set) trying to pass a
      // DIFFERENT shop's id in the query string must be forced to their
      // own — this is the exact leak this session's own controller fix
      // closed (a shop manager could otherwise see another branch's live
      // fleet, or the whole platform's, just by adding ?shopId=... or
      // omitting it).
      await controller.getLiveLocations(
        { shopId: 'my-shop', query: { shopId: 'someone-elses-shop' } },
        fakeReply()
      )
      expect(getLiveLocations).toHaveBeenCalledWith('my-shop')
    } finally {
      restore()
    }
  })

  it('getLiveLocations still honours an explicit query shopId for a true HQ caller (Coverage Map)', async () => {
    const getLiveLocations = vi.fn().mockResolvedValue([])
    const restore = stubService({ getLiveLocations })
    try {
      const controller = new AdminRidersController()
      await controller.getLiveLocations(
        { shopId: null, query: { shopId: 'coverage-map-shop' } },
        fakeReply()
      )
      expect(getLiveLocations).toHaveBeenCalledWith('coverage-map-shop')
    } finally {
      restore()
    }
  })

  it('getLiveLocations keeps the unscoped fleet-wide view when neither is set', async () => {
    const getLiveLocations = vi.fn().mockResolvedValue([])
    const restore = stubService({ getLiveLocations })
    try {
      const controller = new AdminRidersController()
      await controller.getLiveLocations({ shopId: null, query: {} }, fakeReply())
      expect(getLiveLocations).toHaveBeenCalledWith(null)
    } finally {
      restore()
    }
  })

  it('searchByPhone returns 404 when the service finds nothing', async () => {
    const restore = stubService({ searchByPhone: async () => null })
    try {
      const controller = new AdminRidersController()
      const reply = fakeReply()
      await controller.searchByPhone({ query: { phone: '0000000000' }, shopId: 'shop-1' }, reply)
      expect(reply.code).toHaveBeenCalledWith(404)
    } finally {
      restore()
    }
  })

  it('searchByPhone passes the caller\'s shopId through for the ownership flag', async () => {
    const searchByPhone = vi.fn().mockResolvedValue({ id: 'rider-1', assigned_to_my_shop: true })
    const restore = stubService({ searchByPhone })
    try {
      const controller = new AdminRidersController()
      await controller.searchByPhone({ query: { phone: '9700000001' }, shopId: 'shop-1' }, fakeReply())
      expect(searchByPhone).toHaveBeenCalledWith('9700000001', 'shop-1')
    } finally {
      restore()
    }
  })

  it('setMyShopAssignment uses request.shopId, never a client-supplied shop id', async () => {
    const setMyShopAssignment = vi.fn().mockResolvedValue({ id: 'a1', is_active: true })
    const restore = stubService({ setMyShopAssignment })
    try {
      const controller = new AdminRidersController()
      await controller.setMyShopAssignment(
        { params: { id: 'rider-1' }, body: { active: true }, shopId: 'my-shop', user: { id: 'user-1' }, ip: '1.2.3.4' },
        fakeReply()
      )
      expect(setMyShopAssignment).toHaveBeenCalledWith('rider-1', 'my-shop', true, 'user-1', '1.2.3.4')
    } finally {
      restore()
    }
  })

  it('setMyShopAssignment returns 404 when the rider does not exist', async () => {
    const restore = stubService({ setMyShopAssignment: async () => null })
    try {
      const controller = new AdminRidersController()
      const reply = fakeReply()
      await controller.setMyShopAssignment(
        { params: { id: 'rider-x' }, body: { active: true }, shopId: 'shop-1', user: { id: 'user-1' }, ip: null },
        reply
      )
      expect(reply.code).toHaveBeenCalledWith(404)
    } finally {
      restore()
    }
  })
})
