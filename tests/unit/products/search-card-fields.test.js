import { describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../../src/config/database.js', () => ({ query }))
vi.mock('../../../src/modules/allocation/single-store.js', () => ({
  isSingleStoreMode: () => true,
  getPlatformShopIds: async () => ['shop-1'],
}))

const { ProductsController } = await import('../../../src/modules/products/products.controller.js')

// Search results must carry the seller + brand the product card shows.
describe('GET /products/search', () => {
  it('adds sold_by and brand to every result', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'p1', created_at: '2026-10-01', attributes: null, brand: 'Apple', seller: 'TechHub Store' }] })
      .mockResolvedValueOnce({ rows: [{ name: 'Dealker Official' }] })
    const service = {
      search: vi.fn().mockResolvedValue({
        data: [{ id: 'p1', name: 'Apple iPhone 15' }],
        suggestions: [],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    }
    const controller = new ProductsController(service)
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() }
    await controller.search({ query: { q: 'iphone' }, user: null, headers: {}, server: {} }, reply)
    const body = reply.send.mock.calls[0][0]
    expect(body.data[0]).toMatchObject({ id: 'p1', sold_by: 'TechHub Store', brand: 'Apple' })
  })
})
