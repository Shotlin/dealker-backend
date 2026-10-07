import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../../src/utils/audit-log.js', () => ({
  emitInTx: vi.fn(),
}))

import { AdminFinanceService } from '../../../../src/modules/admin/finance/service.js'
import { query, getClient } from '../../../../src/config/database.js'

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const PERIOD_ID = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AdminFinanceService — HQ-wide flat views (dashboard Transactions/Financials tabs)', () => {
  let repo
  let service

  beforeEach(() => {
    repo = {
      findTransactions: vi.fn().mockResolvedValue({ items: [{ id: 't-1' }], total: 1 }),
      findFinancials: vi.fn().mockResolvedValue({ items: [{ id: 'f-1' }], total: 1 }),
    }
    service = new AdminFinanceService(repo, {})
  })

  it('listTransactions delegates straight to repo.findTransactions with all filters', async () => {
    const filters = { page: 2, limit: 20, shop_id: SHOP_ID }
    const result = await service.listTransactions(filters)
    expect(repo.findTransactions).toHaveBeenCalledWith(filters)
    expect(result).toEqual({ items: [{ id: 't-1' }], total: 1 })
  })

  it('listFinancials delegates straight to repo.findFinancials with all filters', async () => {
    const filters = { page: 1, limit: 20, payout_status: 'PENDING' }
    const result = await service.listFinancials(filters)
    expect(repo.findFinancials).toHaveBeenCalledWith(filters)
    expect(result).toEqual({ items: [{ id: 'f-1' }], total: 1 })
  })
})

describe('AdminFinanceService.markPaidById — flat mark-paid (no shopId required)', () => {
  let repo
  let service
  let client

  beforeEach(() => {
    client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
    getClient.mockResolvedValue(client)
    repo = {
      findFinancialById: vi.fn(),
    }
    service = new AdminFinanceService(repo, {})
  })

  it('returns NOT_FOUND when the row does not exist', async () => {
    repo.findFinancialById.mockResolvedValue(null)
    const result = await service.markPaidById(PERIOD_ID, 'admin-1')
    expect(result).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Financial period not found',
    })
    expect(client.query).not.toHaveBeenCalled()
  })

  it('returns ALREADY_PAID without touching the DB when already paid', async () => {
    repo.findFinancialById.mockResolvedValue({
      id: PERIOD_ID,
      shop_id: SHOP_ID,
      payout_status: 'PAID',
    })
    const result = await service.markPaidById(PERIOD_ID, 'admin-1')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ALREADY_PAID')
    expect(client.query).not.toHaveBeenCalled()
  })

  it('resolves shopId from the row itself and commits the UPDATE + audit', async () => {
    repo.findFinancialById.mockResolvedValue({
      id: PERIOD_ID,
      shop_id: SHOP_ID,
      payout_status: 'PENDING',
    })
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE shop_financials')) {
        return Promise.resolve({
          rows: [{ id: PERIOD_ID, shop_id: SHOP_ID, payout_status: 'PAID' }],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    const result = await service.markPaidById(PERIOD_ID, 'admin-1')

    expect(result.ok).toBe(true)
    expect(result.row.payout_status).toBe('PAID')
    // BEGIN, UPDATE, COMMIT — no shopId param needed from the caller
    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE shop_financials')
    )
    expect(updateCall[1]).toEqual([PERIOD_ID, SHOP_ID])
  })
})

describe('AdminFinanceRepository — flat cross-shop queries join shops for shop_name', () => {
  it('findTransactions filters by shop_id only when provided, otherwise queries all shops', async () => {
    const { AdminFinanceRepository } = await import(
      '../../../../src/modules/admin/finance/repository.js'
    )
    query.mockResolvedValue({ rows: [] })
    const repo = new AdminFinanceRepository()

    await repo.findTransactions({ page: 1, limit: 20 })
    const [sqlNoFilter, paramsNoFilter] = query.mock.calls[0]
    expect(sqlNoFilter).toContain('JOIN shops s ON s.id = t.shop_id')
    expect(sqlNoFilter).not.toContain('WHERE')
    expect(paramsNoFilter).toEqual([20, 0])

    query.mockClear()
    await repo.findTransactions({ page: 1, limit: 20, shop_id: SHOP_ID })
    const [sqlFiltered, paramsFiltered] = query.mock.calls[0]
    expect(sqlFiltered).toContain('t.shop_id = $1')
    expect(paramsFiltered).toEqual([SHOP_ID, 20, 0])
  })

  it('findFinancials aliases gross_revenue/platform_commission to the dashboard shape', async () => {
    const { AdminFinanceRepository } = await import(
      '../../../../src/modules/admin/finance/repository.js'
    )
    query.mockResolvedValue({ rows: [] })
    const repo = new AdminFinanceRepository()

    await repo.findFinancials({ page: 1, limit: 20 })
    const [sql] = query.mock.calls[0]
    expect(sql).toContain('sf.gross_revenue AS total_revenue')
    expect(sql).toContain('sf.platform_commission AS commission_amount')
    expect(sql).toContain('s.name AS shop_name')
  })
})
