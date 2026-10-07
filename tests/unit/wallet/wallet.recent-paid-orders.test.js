import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { WalletRepository } from '../../../src/modules/wallet/wallet.repository.js'

/**
 * Coverage for getRecentPaidOrderAmounts() — powers the Credit Wallet
 * dialog's "does this amount match a real paid order" warning. Must filter
 * on payment_status = 'PAID' specifically (not just "not cancelled") so a
 * COD order that was cancelled before delivery, or an ONLINE order whose
 * payment window expired unpaid, never counts as something the customer
 * actually paid for.
 */
describe('WalletRepository.getRecentPaidOrderAmounts', () => {
  it("filters on payment_status = 'PAID' and maps rows to {orderNumber, amount}", async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({
      rows: [{ order_number: 'BKLOO-1', total_amount: '104.00' }],
    })
    const repo = new WalletRepository()

    const result = await repo.getRecentPaidOrderAmounts('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/payment_status\s*=\s*'PAID'/)
    expect(params[0]).toBe('user-1')
    expect(result).toEqual([{ orderNumber: 'BKLOO-1', amount: 104 }])
  })
})
