// Soft-delete predicate coverage for ShopsRepository (Requirements 15.2, 15.3).
//
// The property test in tests/property/soft-delete-preservation.property.test.js
// exercises the same invariant against ShopProductsRepository as a
// representative. These unit tests assert that ShopsRepository's findById and
// findMany apply the `deleted_at IS NULL` predicate by default and surface
// soft-deleted rows only when the caller opts in via `includeDeleted: true`
// (or the equivalent `include_deleted: 'true'` query param shape used by the
// route layer).
//
// The repository's only DB dependency is `query()` from src/config/database.js.
// We mock it so we can inspect the exact SQL fragments emitted. The mocked
// `query` is invoked with parameterized SQL ($1, $2…) — never string
// concatenation — matching the project parameterized-query standard.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

import { ShopsRepository } from '../../../src/modules/shops/shops.repository.js'

const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
})

describe('ShopsRepository.findById — soft-delete predicate (Req 15.3)', () => {
  it('default scope appends `AND deleted_at IS NULL`', async () => {
    const repo = new ShopsRepository()
    await repo.findById(SHOP_ID)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+deleted_at\s+IS\s+NULL/i)
    expect(params).toEqual([SHOP_ID])
  })

  it('omits the predicate when `includeDeleted: true` is passed (Req 15.2)', async () => {
    const repo = new ShopsRepository()
    await repo.findById(SHOP_ID, { includeDeleted: true })

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL/i)
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s*$/i)
  })
})

describe('ShopsRepository.findMany — soft-delete predicate (Req 15.3)', () => {
  it('default list query filters out soft-deleted rows', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopsRepository()
    await repo.findMany({ page: 1, limit: 20 })

    const dataSql = databaseMock.query.mock.calls[0][0]
    const countSql = databaseMock.query.mock.calls[1][0]
    expect(dataSql).toMatch(/s\.deleted_at\s+IS\s+NULL/i)
    expect(countSql).toMatch(/s\.deleted_at\s+IS\s+NULL/i)
  })

  it('drops the predicate when `includeDeleted: true` is passed (Req 15.2)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopsRepository()
    await repo.findMany({ page: 1, limit: 20, includeDeleted: true })

    const dataSql = databaseMock.query.mock.calls[0][0]
    const countSql = databaseMock.query.mock.calls[1][0]
    expect(dataSql).not.toMatch(/s\.deleted_at\s+IS\s+NULL/i)
    expect(countSql).not.toMatch(/s\.deleted_at\s+IS\s+NULL/i)
  })

  it('also accepts the route-shape opt-in `include_deleted: "true"`', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopsRepository()
    await repo.findMany({ page: 1, limit: 20, include_deleted: 'true' })

    const dataSql = databaseMock.query.mock.calls[0][0]
    expect(dataSql).not.toMatch(/s\.deleted_at\s+IS\s+NULL/i)
  })

  it('combines the deleted predicate with other filters via AND', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 1 })
    const repo = new ShopsRepository()
    await repo.findMany({
      page: 1,
      limit: 20,
      city: 'Bangalore',
      is_active: 'true',
    })

    const dataSql = databaseMock.query.mock.calls[0][0]
    expect(dataSql).toMatch(/s\.deleted_at\s+IS\s+NULL/i)
    expect(dataSql).toMatch(/s\.city\s+ILIKE/i)
    expect(dataSql).toMatch(/s\.is_active\s*=\s*true/i)
  })
})

describe('ShopsRepository.softDelete — converts hard delete to soft delete (Req 15.2)', () => {
  it('issues UPDATE … SET deleted_at = NOW() instead of DELETE FROM shops', async () => {
    databaseMock.query.mockResolvedValue({ rows: [], rowCount: 1 })
    const repo = new ShopsRepository()
    const ok = await repo.softDelete(SHOP_ID)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+shops/i)
    expect(sql).toMatch(/SET\s+deleted_at\s*=\s*NOW\(\)/i)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+shops/i)
    // Idempotent: the WHERE guard prevents double soft-delete from
    // bumping updated_at on an already-deleted row.
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+deleted_at\s+IS\s+NULL/i)
    expect(params).toEqual([SHOP_ID])
    expect(ok).toBe(true)
  })

  it('returns false when no row was updated (already deleted or missing)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
    const repo = new ShopsRepository()
    const ok = await repo.softDelete(SHOP_ID)
    expect(ok).toBe(false)
  })
})

describe('ShopsRepository.update — never resurrects soft-deleted rows (Req 15.2)', () => {
  it('UPDATE statement includes `AND deleted_at IS NULL` guard', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ id: SHOP_ID }], rowCount: 1 })
    const repo = new ShopsRepository()
    await repo.update(SHOP_ID, { phone: '9999999999' })

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+shops\s+SET/i)
    expect(sql).toMatch(/AND\s+deleted_at\s+IS\s+NULL/i)
  })
})


describe('ShopsRepository — serviceable_pincodes are cleaned on every write path', () => {
  it('update() persists a whitespace-stripped, de-duplicated list', async () => {
    const repo = new ShopsRepository()
    await repo.update(SHOP_ID, { serviceable_pincodes: ['201301', ' 201301', '', '700 016', '201301'] })

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/serviceable_pincodes\s*=\s*\$\d+/)
    expect(params).toContainEqual(['201301', '700016'])
  })

  it('create() persists a whitespace-stripped, de-duplicated list', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ id: SHOP_ID }], rowCount: 1 })
    const repo = new ShopsRepository()
    await repo.create({
      name: 'S', slug: 's', branch_code: 'KOL001',
      address_line1: 'a', city: 'Kolkata', state: 'WB', pincode: '700001',
      lat: 22.5, lng: 88.3, delivery_radius_km: 5, commission_rate: 10,
      serviceable_pincodes: ['201301', '201301'],
    })

    const [, params] = databaseMock.query.mock.calls[0]
    expect(params).toContainEqual(['201301'])
  })
})
