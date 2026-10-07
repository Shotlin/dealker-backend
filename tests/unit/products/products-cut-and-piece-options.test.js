import { describe, expect, it, vi, beforeEach } from 'vitest'

// "Choose Your Cut" / "Available Pieces" (migration 148) — customer-facing,
// admin-typed, same-SKU option lists (e.g. Tikka/Curry Cut/Boneless, or
// Small/Medium/Large — not a fixed 3-value enum). Covers the same 3
// mistakes the customBadges/nutritionInfo history in this file already
// caught once each: (1) create() must actually write the column, (2)
// update() must be reachable and JSON.stringify the array (a JSONB column
// silently receiving a raw JS array from a fieldMap entry, instead of a
// JSON.stringify'd string, is wrong for this driver), (3) every SELECT that
// already returns custom_badges/display_delivery_minutes must also return
// the two new columns, or the mobile client never sees them at all.
const queryMock = vi.fn(async () => ({ rows: [{ id: 'product-1' }] }))
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))

const { ProductsRepository } = await import('../../../src/modules/products/products.repository.js')

beforeEach(() => {
  queryMock.mockClear()
})

describe('ProductsRepository — cutOptions/pieceOptions', () => {
  it('create() writes both columns as JSON, defaulting to an empty array when omitted', async () => {
    const repo = new ProductsRepository()
    await repo.create({ name: 'Chicken', slug: 'chicken', price: 100 })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/cut_options/)
    expect(sql).toMatch(/piece_options/)
    expect(params).toContainEqual('[]')
  })

  it('create() serializes real admin-typed options', async () => {
    const repo = new ProductsRepository()
    await repo.create({
      name: 'Chicken',
      slug: 'chicken',
      price: 100,
      cutOptions: ['Tikka', 'Curry Cut', 'Boneless'],
      pieceOptions: ['Small', 'Medium', 'Large'],
    })

    const [, params] = queryMock.mock.calls[0]
    expect(params).toContainEqual(JSON.stringify(['Tikka', 'Curry Cut', 'Boneless']))
    expect(params).toContainEqual(JSON.stringify(['Small', 'Medium', 'Large']))
  })

  it('create()\'s VALUES placeholder count matches its params array length', async () => {
    const repo = new ProductsRepository()
    await repo.create({ name: 'Chicken', slug: 'chicken', price: 100 })

    const [sql, params] = queryMock.mock.calls[0]
    const placeholderMatches = sql.match(/\$\d+/g) ?? []
    const highestPlaceholder = Math.max(...placeholderMatches.map((p) => Number(p.slice(1))))
    expect(highestPlaceholder).toBe(params.length)
  })

  it('update() writes cutOptions as a JSON string, not a raw JS array', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { cutOptions: ['Fillet', 'Stripes'] })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/cut_options = \$/)
    expect(params).toContainEqual(JSON.stringify(['Fillet', 'Stripes']))
  })

  it('update() writes pieceOptions as a JSON string', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { pieceOptions: ['Small', 'Medium', 'Large', 'Extra Large'] })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/piece_options = \$/)
    expect(params).toContainEqual(JSON.stringify(['Small', 'Medium', 'Large', 'Extra Large']))
  })

  it('update() allows clearing to an empty list', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { cutOptions: [] })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/cut_options = \$/)
    expect(params).toContainEqual('[]')
  })

  it('update() does not touch either column when both keys are omitted', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { name: 'Chicken Curry Cut' })

    const [sql] = queryMock.mock.calls[0]
    expect(sql).not.toMatch(/cut_options/)
    expect(sql).not.toMatch(/piece_options/)
  })

  it('findById selects both new columns alongside custom_badges', async () => {
    const repo = new ProductsRepository()
    await repo.findById('product-1')

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/p\.custom_badges,\s*p\.display_delivery_minutes,\s*p\.cut_options,\s*p\.piece_options/)
  })

  it('findBySlug selects both new columns', async () => {
    const repo = new ProductsRepository()
    await repo.findBySlug('chicken-curry-cut')

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/p\.cut_options,\s*p\.piece_options/)
  })

  it('findMany (list) selects both new columns', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({})

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/p\.cut_options,\s*p\.piece_options/)
  })
})
