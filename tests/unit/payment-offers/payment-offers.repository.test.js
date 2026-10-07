import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { PaymentOffersRepository } from '../../../src/modules/payment-offers/payment-offers.repository.js'

/**
 * Regression coverage for getActive() never filtering on valid_from — a
 * future-dated offer (valid_from set ahead of NOW()) went live immediately
 * instead of waiting for its scheduled start, because the WHERE clause only
 * ever checked valid_until, unlike first-time-offers.repository.js's
 * findBestFitActive() which correctly checks both start_at and end_at.
 */
describe('PaymentOffersRepository.getActive — valid_from is now enforced', () => {
  it('filters on both valid_from and valid_until, alongside is_active', async () => {
    queryMock.mockClear()
    const repo = new PaymentOffersRepository()

    await repo.getActive()

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/is_active\s*=\s*true/)
    expect(sql).toMatch(/valid_from\s+IS\s+NULL\s+OR\s+valid_from\s*<=\s*NOW\(\)/i)
    expect(sql).toMatch(/valid_until\s+IS\s+NULL\s+OR\s+valid_until\s*>\s*NOW\(\)/i)
  })
})
