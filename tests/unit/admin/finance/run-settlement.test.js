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

const SHOP_ID = '11111111-1111-1111-1111-111111111111'

function makeFakeSettlementService() {
  return {
    settleShopForPeriod: vi.fn().mockResolvedValue({
      shopId: SHOP_ID,
      periodType: 'DAILY',
      row: { id: 'row-1' },
    }),
    runDailySettlementForDate: vi.fn().mockResolvedValue({
      settled: 3,
      skipped: 1,
      failed: 0,
      periodStart: '2026-07-04',
    }),
  }
}

describe('AdminFinanceService.runSettlementNow', () => {
  let repo
  let settlementService
  let service

  beforeEach(() => {
    repo = {}
    settlementService = makeFakeSettlementService()
    service = new AdminFinanceService(repo, settlementService)
  })

  it('settles a single shop for today (UTC) when no periodDate is given', async () => {
    const result = await service.runSettlementNow({ shopId: SHOP_ID, actorId: 'admin-1' })

    expect(settlementService.settleShopForPeriod).toHaveBeenCalledTimes(1)
    const [shopId, periodType, periodStart, periodEnd, options] =
      settlementService.settleShopForPeriod.mock.calls[0]
    expect(shopId).toBe(SHOP_ID)
    expect(periodType).toBe('DAILY')
    expect(periodStart).toBe(periodEnd) // single-day period
    expect(options.startUtc).toBeInstanceOf(Date)
    expect(options.endUtc.getTime() - options.startUtc.getTime()).toBe(
      24 * 60 * 60 * 1000
    )

    expect(result.mode).toBe('SINGLE_SHOP')
    expect(result.shopId).toBe(SHOP_ID)
    expect(settlementService.runDailySettlementForDate).not.toHaveBeenCalled()
  })

  it('respects an explicit periodDate for the single-shop path', async () => {
    await service.runSettlementNow({
      shopId: SHOP_ID,
      periodDate: '2026-01-15',
      actorId: 'admin-1',
    })

    const [, , periodStart, periodEnd] =
      settlementService.settleShopForPeriod.mock.calls[0]
    expect(periodStart).toBe('2026-01-15')
    expect(periodEnd).toBe('2026-01-15')
  })

  it('runs the all-shops path via runDailySettlementForDate when no shopId is given', async () => {
    const result = await service.runSettlementNow({
      periodDate: '2026-07-04',
      actorId: 'admin-1',
    })

    expect(settlementService.runDailySettlementForDate).toHaveBeenCalledWith({
      dateStr: '2026-07-04',
    })
    expect(settlementService.settleShopForPeriod).not.toHaveBeenCalled()
    expect(result.mode).toBe('ALL_SHOPS')
    expect(result.summary).toEqual({
      settled: 3,
      skipped: 1,
      failed: 0,
      periodStart: '2026-07-04',
    })
  })

  it('defaults to today (UTC) for the all-shops path when periodDate is omitted', async () => {
    await service.runSettlementNow({ actorId: 'admin-1' })

    const [{ dateStr }] = settlementService.runDailySettlementForDate.mock.calls[0]
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
