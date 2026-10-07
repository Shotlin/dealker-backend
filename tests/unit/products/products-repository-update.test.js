import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression test for a real production bug: nutritionInfo was completely
// absent from ProductsRepository.update()'s field map, so it saved fine on
// product create but every subsequent edit silently discarded it — the
// request 200'd, the dashboard said "Product updated", and nutrition_info
// in Postgres never changed. Also covers the sibling "can't clear an
// optional field" bug: once the dashboard was fixed to send '' / [] / {}
// instead of omitting the key, an empty string must reach the UPDATE as
// NULL, not be skipped.
const queryMock = vi.fn(async () => ({ rows: [{ id: 'product-1' }] }))
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))

const { ProductsRepository } = await import('../../../src/modules/products/products.repository.js')

beforeEach(() => {
  queryMock.mockClear()
})

describe('ProductsRepository.update — nutritionInfo', () => {
  it('includes nutrition_info in the UPDATE when nutritionInfo is provided', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { nutritionInfo: { Energy: '50 kcal', Protein: '2 g' } })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/nutrition_info = \$/)
    expect(params).toContainEqual({ Energy: '50 kcal', Protein: '2 g' })
  })

  it('clears nutrition_info when an empty object is sent (user removed all rows)', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { nutritionInfo: {} })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/nutrition_info = \$/)
    expect(params).toContainEqual({})
  })

  it('does not touch nutrition_info when the key is omitted entirely', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { name: 'Tomato (Tameta)' })

    const [sql] = queryMock.mock.calls[0]
    expect(sql).not.toMatch(/nutrition_info/)
  })
})

describe('ProductsRepository.update — clearing optional text fields', () => {
  it('converts an empty-string vendorName to NULL instead of skipping the column', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { vendorName: '' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/vendor_name = \$/)
    expect(params).toContain(null)
  })

  it('updates vendorAddress/vendorFssai to new non-blank values', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { vendorAddress: 'New address', vendorFssai: '12345' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/vendor_address = \$/)
    expect(sql).toMatch(/vendor_fssai = \$/)
    expect(params).toContain('New address')
    expect(params).toContain('12345')
  })
})

describe('ProductsRepository.update — certifications', () => {
  it('clears certifications when an empty array is sent', async () => {
    const repo = new ProductsRepository()
    await repo.update('product-1', { certifications: [] })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/certifications = \$/)
    expect(params).toContainEqual([])
  })
})
