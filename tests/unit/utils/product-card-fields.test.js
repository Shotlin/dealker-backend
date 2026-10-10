import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../../src/config/database.js', () => ({ query }))

const { withCardFields } = await import('../../../src/utils/product-card-fields.js')

describe('withCardFields', () => {
  beforeEach(() => query.mockReset())

  it('adds sold_by (vendor, else platform store), created_at and attributes', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 'a', created_at: '2026-10-01', attributes: [{ name: 'Storage', value: '256GB' }], seller: 'TechHub Store' },
        { id: 'b', created_at: '2026-09-01', attributes: null, seller: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ name: 'Dealker Official' }] })
    const out = await withCardFields([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }])
    expect(out[0]).toMatchObject({ sold_by: 'TechHub Store', created_at: '2026-10-01' })
    expect(out[0].attributes).toEqual([{ name: 'Storage', value: '256GB' }])
    expect(out[1].sold_by).toBe('Dealker Official')
    expect(out[2]).toEqual({ id: 'c', name: 'C' }) // unknown id: unchanged
  })

  it('does not query for an empty list', async () => {
    expect(await withCardFields([])).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
})
