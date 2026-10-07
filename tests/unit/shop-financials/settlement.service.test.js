import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock IO modules so the smoke test stays pure ─────────────
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { SettlementService } from '../../../src/modules/shop-financials/settlement.service.js'

// ═══════════════════════════════════════════════════════════
// Pure compute helpers — Property 8 (Financial Formula)
// Validates: Requirements 6.3, 6.4
// ═══════════════════════════════════════════════════════════

describe('SettlementService.computeCommission (Req 6.3)', () => {
  it('= gross * rate / 100, rounded to 2dp', () => {
    expect(SettlementService.computeCommission(1000, 10)).toBe(100)
    expect(SettlementService.computeCommission(1234.56, 12.5)).toBe(154.32)
    expect(SettlementService.computeCommission(0, 10)).toBe(0)
    expect(SettlementService.computeCommission(100, 0)).toBe(0)
  })

  it('handles non-finite / non-numeric inputs as 0', () => {
    expect(SettlementService.computeCommission(NaN, 10)).toBe(0)
    expect(SettlementService.computeCommission(100, Infinity)).toBe(0)
    expect(SettlementService.computeCommission(undefined, 10)).toBe(0)
    expect(SettlementService.computeCommission('abc', 10)).toBe(0)
  })

  it('coerces numeric strings (DECIMAL columns return strings from pg)', () => {
    expect(SettlementService.computeCommission('500.00', '10')).toBe(50)
  })
})

describe('SettlementService.computeNetRevenue (Req 6.4)', () => {
  // net = gross - commission - delivery - refund
  it('subtracts commission, delivery, refund from gross', () => {
    expect(SettlementService.computeNetRevenue(1000, 100, 50, 0)).toBe(850)
    expect(SettlementService.computeNetRevenue(1000, 100, 50, 25)).toBe(825)
  })

  it('preserves negative results (refund > gross is legal mathematically)', () => {
    expect(SettlementService.computeNetRevenue(100, 0, 0, 200)).toBe(-100)
  })

  it('rounds to 2 decimal places', () => {
    expect(SettlementService.computeNetRevenue(100.005, 0, 0, 0)).toBe(100.01)
  })
})

describe('SettlementService.computeAvgOrderValue', () => {
  it('= gross / total_orders', () => {
    expect(SettlementService.computeAvgOrderValue(1000, 4)).toBe(250)
    expect(SettlementService.computeAvgOrderValue(333, 3)).toBe(111)
  })

  it('returns 0 when total_orders is 0 (no division by zero)', () => {
    expect(SettlementService.computeAvgOrderValue(1000, 0)).toBe(0)
  })

  it('rounds to 2dp', () => {
    expect(SettlementService.computeAvgOrderValue(100, 3)).toBe(33.33)
  })
})

// ═══════════════════════════════════════════════════════════
// Period helpers
// ═══════════════════════════════════════════════════════════

describe('SettlementService period helpers', () => {
  it('previousUtcDay returns yesterday relative to a UTC reference', () => {
    const ref = new Date('2024-03-15T12:34:56.000Z')
    const { dateStr, startUtc, endUtc } = SettlementService.previousUtcDay(ref)
    expect(dateStr).toBe('2024-03-14')
    expect(startUtc.toISOString()).toBe('2024-03-14T00:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2024-03-15T00:00:00.000Z')
  })

  it('previousUtcDay handles month boundaries', () => {
    const ref = new Date('2024-04-01T01:00:00.000Z')
    expect(SettlementService.previousUtcDay(ref).dateStr).toBe('2024-03-31')
  })

  it('weekStartFor finds the ISO Monday of any day', () => {
    expect(SettlementService.weekStartFor(new Date('2024-03-15T00:00:00Z'))).toBe('2024-03-11')
    expect(SettlementService.weekStartFor(new Date('2024-03-17T00:00:00Z'))).toBe('2024-03-11') // Sunday
    expect(SettlementService.weekStartFor(new Date('2024-03-11T00:00:00Z'))).toBe('2024-03-11') // Monday itself
  })

  it('weekEndFor returns Sunday after a given Monday', () => {
    expect(SettlementService.weekEndFor('2024-03-11')).toBe('2024-03-17')
  })

  it('monthStartFor / monthEndFor handle month boundaries', () => {
    expect(SettlementService.monthStartFor(new Date('2024-02-15T00:00:00Z'))).toBe('2024-02-01')
    expect(SettlementService.monthEndFor(new Date('2024-02-15T00:00:00Z'))).toBe('2024-02-29') // 2024 leap year
    expect(SettlementService.monthEndFor(new Date('2024-04-15T00:00:00Z'))).toBe('2024-04-30')
  })
})

// ═══════════════════════════════════════════════════════════
// settleShopForPeriod — DAILY path
// Validates: Requirements 6.2, 6.3, 6.4, 14.6, 14.11
// ═══════════════════════════════════════════════════════════

function makeMockedService(overrides = {}) {
  const writeRepository = {
    aggregateDeliveredOrders: vi.fn().mockResolvedValue({
      grossRevenue: 1000,
      totalOrders: 4,
      deliveryCosts: 50,
    }),
    sumDailyRows: vi.fn().mockResolvedValue({
      dailyCount: 7,
      grossRevenue: 7000,
      totalOrders: 28,
      platformCommission: 700,
      deliveryCosts: 350,
      refundAmount: 0,
      netRevenue: 5950,
      payoutAmount: 5950,
    }),
    upsert: vi.fn().mockImplementation(async (fields) => ({ id: 'row-1', ...fields })),
    listActiveShopsPage: vi.fn().mockResolvedValue([]),
    findCommissionRate: vi.fn().mockResolvedValue(10),
    ...overrides.writeRepository,
  }
  const financialsService = {
    invalidateForShop: vi.fn().mockResolvedValue(undefined),
    ...overrides.financialsService,
  }
  return new SettlementService({ writeRepository, financialsService })
}

describe('SettlementService.settleShopForPeriod — DAILY', () => {
  it('aggregates orders, computes formulas, UPSERTs, invalidates cache', async () => {
    const svc = makeMockedService()
    const result = await svc.settleShopForPeriod(
      'shop-1',
      'DAILY',
      '2024-03-14',
      '2024-03-14',
      { commissionRate: 10 }
    )
    expect(result.row).toBeDefined()
    // commission = 1000 * 10 / 100 = 100
    // net        = 1000 - 100 - 50 - 0 = 850
    // avg        = 1000 / 4 = 250
    expect(result.row.platformCommission).toBe(100)
    expect(result.row.netRevenue).toBe(850)
    expect(result.row.payoutAmount).toBe(850)
    expect(result.row.avgOrderValue).toBe(250)
    expect(result.row.totalOrders).toBe(4)
    expect(result.row.grossRevenue).toBe(1000)
    expect(result.row.deliveryCosts).toBe(50)
    expect(result.row.refundAmount).toBe(0)
    expect(svc.financialsService.invalidateForShop).toHaveBeenCalledWith('shop-1')
  })

  it('falls back to repo lookup when commission rate is not provided', async () => {
    const svc = makeMockedService()
    await svc.settleShopForPeriod('shop-1', 'DAILY', '2024-03-14', '2024-03-14', {})
    expect(svc.writeRepo.findCommissionRate).toHaveBeenCalledWith('shop-1')
  })

  it('handles a zero-order day with avg=0 and commission=0', async () => {
    const svc = makeMockedService({
      writeRepository: {
        aggregateDeliveredOrders: vi.fn().mockResolvedValue({
          grossRevenue: 0,
          totalOrders: 0,
          deliveryCosts: 0,
        }),
      },
    })
    const result = await svc.settleShopForPeriod(
      'shop-1',
      'DAILY',
      '2024-03-14',
      '2024-03-14',
      { commissionRate: 10 }
    )
    expect(result.row.totalOrders).toBe(0)
    expect(result.row.grossRevenue).toBe(0)
    expect(result.row.platformCommission).toBe(0)
    expect(result.row.netRevenue).toBe(0)
    expect(result.row.avgOrderValue).toBe(0)
  })

  it('cache invalidation failure does not abort the write', async () => {
    const svc = makeMockedService({
      financialsService: {
        invalidateForShop: vi.fn().mockRejectedValue(new Error('redis down')),
      },
    })
    await expect(
      svc.settleShopForPeriod('shop-1', 'DAILY', '2024-03-14', '2024-03-14', {
        commissionRate: 10,
      })
    ).resolves.toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════
// WEEKLY / MONTHLY aggregation — Req 6.9
// ═══════════════════════════════════════════════════════════

describe('SettlementService.settleShopForPeriod — WEEKLY (Req 6.9)', () => {
  it('skips when fewer than 7 daily rows exist', async () => {
    const svc = makeMockedService({
      writeRepository: {
        sumDailyRows: vi.fn().mockResolvedValue({
          dailyCount: 5,
          grossRevenue: 0, totalOrders: 0, platformCommission: 0,
          deliveryCosts: 0, refundAmount: 0, netRevenue: 0, payoutAmount: 0,
        }),
      },
    })
    const result = await svc.settleShopForPeriod(
      'shop-1', 'WEEKLY', '2024-03-11', '2024-03-17', { requireDailyCount: 7 }
    )
    expect(result.skipped).toBe(true)
    expect(svc.writeRepo.upsert).not.toHaveBeenCalled()
  })

  it('UPSERTs when all 7 daily rows are present', async () => {
    const svc = makeMockedService()
    const result = await svc.settleShopForPeriod(
      'shop-1', 'WEEKLY', '2024-03-11', '2024-03-17', { requireDailyCount: 7 }
    )
    expect(result.row).toBeDefined()
    expect(result.row.grossRevenue).toBe(7000)
    expect(result.row.platformCommission).toBe(700)
    expect(result.row.netRevenue).toBe(5950)
    // avg = 7000 / 28 = 250
    expect(result.row.avgOrderValue).toBe(250)
  })
})

// ═══════════════════════════════════════════════════════════
// runDailySettlement loop — pagination & summary counters
// ═══════════════════════════════════════════════════════════

describe('SettlementService.runDailySettlement', () => {
  let svc

  beforeEach(() => {
    svc = makeMockedService({
      writeRepository: {
        listActiveShopsPage: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'shop-a', commission_rate: 10 },
            { id: 'shop-b', commission_rate: 15 },
          ])
          .mockResolvedValueOnce([]),
      },
    })
  })

  it('iterates active shops and counts settled/failed/skipped', async () => {
    const summary = await svc.runDailySettlement({
      date: new Date('2024-03-15T03:00:00.000Z'),
      batchSize: 50,
    })
    expect(summary.settled).toBe(2)
    expect(summary.failed).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(summary.periodStart).toBe('2024-03-14')
  })

  it('counts shop-level failures without halting the run', async () => {
    svc.writeRepo.aggregateDeliveredOrders = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ grossRevenue: 100, totalOrders: 1, deliveryCosts: 0 })

    const summary = await svc.runDailySettlement({
      date: new Date('2024-03-15T03:00:00.000Z'),
      batchSize: 50,
    })
    expect(summary.failed).toBe(1)
    expect(summary.settled).toBe(1)
  })
})
