// Soft-delete predicate coverage for ShopStaffRepository (Req 15.2, 15.3).
//
// The property test in tests/property/soft-delete-preservation.property.test.js
// generalises Property 18 to all multi-vendor soft-delete tables; these unit
// tests assert the same default-exclude / opt-in-include behaviour for the
// ShopStaffRepository specifically. Mocked `query()` lets us inspect the exact
// SQL fragments emitted without touching Postgres. Every SUT call uses
// parameterized placeholders ($1, $2…) — never string interpolation.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

import { ShopStaffRepository } from '../../../src/modules/shop-staff/shop-staff.repository.js'

const STAFF_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
})

describe('ShopStaffRepository.findById — soft-delete predicate (Req 15.3)', () => {
  it('shop-scoped read appends `AND deleted_at IS NULL` by default', async () => {
    const repo = new ShopStaffRepository()
    await repo.findById(STAFF_ID, SHOP_ID)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(
      /WHERE\s+id\s*=\s*\$1\s+AND\s+shop_id\s*=\s*\$2\s+AND\s+deleted_at\s+IS\s+NULL/i
    )
    expect(params).toEqual([STAFF_ID, SHOP_ID])
  })

  it('omits the predicate when `includeDeleted: true` is passed (Req 15.2)', async () => {
    const repo = new ShopStaffRepository()
    await repo.findById(STAFF_ID, SHOP_ID, { includeDeleted: true })

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL/i)
  })

  it('unscoped read also applies the default predicate', async () => {
    const repo = new ShopStaffRepository()
    await repo.findById(STAFF_ID, null)

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+deleted_at\s+IS\s+NULL/i)
  })

  it('unscoped read with `includeDeleted: true` drops the predicate', async () => {
    const repo = new ShopStaffRepository()
    await repo.findById(STAFF_ID, null, { includeDeleted: true })

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL/i)
  })
})

describe('ShopStaffRepository.findMany — soft-delete predicate (Req 15.3)', () => {
  it('default list query filters out soft-deleted rows', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopStaffRepository()
    await repo.findMany({ shopId: SHOP_ID, page: 1, limit: 20 })

    const dataSql = databaseMock.query.mock.calls[0][0]
    const countSql = databaseMock.query.mock.calls[1][0]
    expect(dataSql).toMatch(/ss\.deleted_at\s+IS\s+NULL/i)
    expect(countSql).toMatch(/ss\.deleted_at\s+IS\s+NULL/i)
  })

  it('drops the predicate when `includeDeleted: true` is passed (Req 15.2)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopStaffRepository()
    await repo.findMany({
      shopId: SHOP_ID,
      page: 1,
      limit: 20,
      includeDeleted: true,
    })

    const dataSql = databaseMock.query.mock.calls[0][0]
    const countSql = databaseMock.query.mock.calls[1][0]
    expect(dataSql).not.toMatch(/ss\.deleted_at\s+IS\s+NULL/i)
    expect(countSql).not.toMatch(/ss\.deleted_at\s+IS\s+NULL/i)
  })

  it('also accepts the route-shape opt-in `include_deleted: "true"`', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopStaffRepository()
    await repo.findMany({
      shopId: SHOP_ID,
      page: 1,
      limit: 20,
      include_deleted: 'true',
    })

    const dataSql = databaseMock.query.mock.calls[0][0]
    expect(dataSql).not.toMatch(/ss\.deleted_at\s+IS\s+NULL/i)
  })
})

describe('ShopStaffRepository.softDelete — converts hard delete to soft delete (Req 15.2)', () => {
  it('issues UPDATE … SET deleted_at = NOW(), is_active = false', async () => {
    databaseMock.query.mockResolvedValue({ rows: [], rowCount: 1 })
    const repo = new ShopStaffRepository()
    const ok = await repo.softDelete(STAFF_ID, SHOP_ID)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+shop_staff/i)
    expect(sql).toMatch(/SET\s+deleted_at\s*=\s*NOW\(\)/i)
    expect(sql).toMatch(/is_active\s*=\s*false/i)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+shop_staff/i)
    expect(sql).toMatch(
      /WHERE\s+id\s*=\s*\$1\s+AND\s+shop_id\s*=\s*\$2\s+AND\s+deleted_at\s+IS\s+NULL/i
    )
    expect(params).toEqual([STAFF_ID, SHOP_ID])
    expect(ok).toBe(true)
  })

  it('returns false when no row matched (already deleted / missing)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
    const repo = new ShopStaffRepository()
    const ok = await repo.softDelete(STAFF_ID, SHOP_ID)
    expect(ok).toBe(false)
  })
})

describe('ShopStaffRepository.update — never resurrects soft-deleted rows (Req 15.2)', () => {
  it('UPDATE statement includes `AND deleted_at IS NULL` guard', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [{ id: STAFF_ID }],
      rowCount: 1,
    })
    const repo = new ShopStaffRepository()
    await repo.update(STAFF_ID, SHOP_ID, { is_active: false })

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+shop_staff\s+SET/i)
    expect(sql).toMatch(/AND\s+deleted_at\s+IS\s+NULL/i)
  })
})

describe('ShopStaffRepository — non-list reads also exclude soft-deleted', () => {
  it('countActiveByShop filters by deleted_at IS NULL', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 0 }], rowCount: 1 })
    const repo = new ShopStaffRepository()
    await repo.countActiveByShop(SHOP_ID)

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i)
  })

  it('countActiveByUser filters by deleted_at IS NULL', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 0 }], rowCount: 1 })
    const repo = new ShopStaffRepository()
    await repo.countActiveByUser(USER_ID)

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i)
  })

  it('findByUserAndShop filters by deleted_at IS NULL', async () => {
    const repo = new ShopStaffRepository()
    await repo.findByUserAndShop(USER_ID, SHOP_ID)

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i)
  })

  it('findActiveUserIdsByShopAndRoles filters by deleted_at IS NULL', async () => {
    const repo = new ShopStaffRepository()
    await repo.findActiveUserIdsByShopAndRoles(SHOP_ID, ['SHOP_ADMIN'])

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i)
  })
})
