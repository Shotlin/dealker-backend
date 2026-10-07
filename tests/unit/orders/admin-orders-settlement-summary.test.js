import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * "Customer money settled" dashboard feature — how much of an order's
 * money has genuinely been collected, split by Cash on Delivery vs.
 * online (Razorpay) vs. wallet balance, and how much is still
 * outstanding. Reuses `_buildOrderFilters`, the same WHERE-clause builder
 * `findAll` uses, so the totals always answer "for exactly the filtered
 * view currently on screen" (same shop scope, date range, status, etc.)
 * — never a different filter set than what's displayed, the same
 * discipline the pre-existing pagination-count query already follows.
 */
const queryMock = vi.fn()
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

const { AdminOrdersRepository } = await import(
  '../../../src/modules/admin/orders/orders.repository.js'
)

describe('AdminOrdersRepository.getSettlementSummary', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('sums COD-collected, online-collected, wallet-collected and pending separately, net of wallet on the settled amounts', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        cod_collected: '380.00',
        online_collected: '1200.00',
        wallet_collected: '150.00',
        pending_amount: '500.00',
        order_count: 7,
      }],
    })

    const repo = new AdminOrdersRepository()
    const summary = await repo.getSettlementSummary({ shopId: null })

    expect(summary).toEqual({
      codCollected: 380,
      onlineCollected: 1200,
      walletCollected: 150,
      pendingAmount: 500,
      orderCount: 7,
    })
  })

  it('applies the same shop scope as findAll — a shop-staff JWT never sees another branch\'s settlement totals', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ cod_collected: '0', online_collected: '0', wallet_collected: '0', pending_amount: '0', order_count: 0 }],
    })

    const repo = new AdminOrdersRepository()
    await repo.getSettlementSummary({ shopId: 'shop-kolkata' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('AND o.shop_id = $1')
    expect(params).toEqual(['shop-kolkata'])
  })

  it('never filters by shop for "All Shops" (shopId null)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ cod_collected: '0', online_collected: '0', wallet_collected: '0', pending_amount: '0', order_count: 0 }],
    })

    const repo = new AdminOrdersRepository()
    await repo.getSettlementSummary({ shopId: null })

    const [sql] = queryMock.mock.calls[0]
    expect(sql).not.toContain('o.shop_id = $')
  })

  it('combines with a date-range filter without cross-contaminating param indices', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ cod_collected: '0', online_collected: '0', wallet_collected: '0', pending_amount: '0', order_count: 0 }],
    })

    const repo = new AdminOrdersRepository()
    await repo.getSettlementSummary({ shopId: 'shop-a', startDate: '2026-09-01T00:00:00Z' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('AND o.shop_id = $1')
    expect(sql).toContain('AND o.created_at >= $2')
    expect(params).toEqual(['shop-a', '2026-09-01T00:00:00Z'])
  })
})
