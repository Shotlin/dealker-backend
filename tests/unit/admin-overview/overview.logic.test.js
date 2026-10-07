import { describe, it, expect } from 'vitest'
import { resolveRange, pctChange, metric, startOfIstDay } from '../../../src/modules/admin/overview/overview.range.js'
import { buildInsights, THRESHOLDS } from '../../../src/modules/admin/overview/overview.insights.js'
import { groupStatuses, deriveFinancials } from '../../../src/modules/admin/overview/overview.service.js'

// 2026-10-01 14:00 IST = 08:30 UTC
const NOW = new Date('2026-10-01T08:30:00Z')

describe('resolveRange', () => {
  it('today is the IST calendar day and compares with the day before', () => {
    const r = resolveRange({ range: 'today' }, NOW)
    expect(r.from.toISOString()).toBe('2026-09-30T18:30:00.000Z') // 00:00 IST
    expect(r.to.toISOString()).toBe('2026-10-01T18:30:00.000Z')
    expect(r.previousTo.getTime()).toBe(r.from.getTime())
    expect(r.days).toBe(1)
  })

  it('yesterday is the full previous IST day', () => {
    const r = resolveRange({ range: 'yesterday' }, NOW)
    expect(r.from.toISOString()).toBe('2026-09-29T18:30:00.000Z')
    expect(r.to.toISOString()).toBe('2026-09-30T18:30:00.000Z')
  })

  it('7d and 30d include today and the previous window has equal length', () => {
    const r7 = resolveRange({ range: '7d' }, NOW)
    expect(r7.days).toBe(7)
    expect(r7.to.getTime() - r7.from.getTime()).toBe(r7.from.getTime() - r7.previousFrom.getTime())
    expect(resolveRange({ range: '30d' }, NOW).days).toBe(30)
  })

  it('custom range is inclusive of the end date', () => {
    const r = resolveRange({ range: 'custom', from: '2026-09-01', to: '2026-09-10' }, NOW)
    expect(r.days).toBe(10)
    expect(r.previousFrom.toISOString()).toBe('2026-08-21T18:30:00.000Z')
  })

  it.each([
    [{ range: 'custom', from: 'nope', to: '2026-09-10' }],
    [{ range: 'custom', from: '2026-09-10', to: '2026-09-01' }],
    [{ range: 'custom', from: '2024-01-01', to: '2026-09-10' }],
  ])('rejects invalid custom range %o', (input) => {
    expect(() => resolveRange(input, NOW)).toThrow(/range|Custom/i)
  })

  it('startOfIstDay handles the late-evening UTC rollover', () => {
    // 20:00 UTC on Sep 30 is already Oct 1 01:30 IST
    expect(startOfIstDay(new Date('2026-09-30T20:00:00Z')).toISOString()).toBe('2026-09-30T18:30:00.000Z')
  })
})

describe('pctChange / metric', () => {
  it('computes percentage change to one decimal', () => {
    expect(pctChange(150, 100)).toBe(50)
    expect(pctChange(80, 100)).toBe(-20)
  })
  it('returns null (not Infinity) when there is no baseline', () => {
    expect(pctChange(10, 0)).toBeNull()
    expect(pctChange(0, 0)).toBe(0)
  })
  it('keeps null values null instead of coercing to 0', () => {
    expect(metric(null, 5)).toEqual({ value: null, previous: 5, change_pct: null })
  })
})

describe('groupStatuses', () => {
  it('buckets raw statuses into the health groups', () => {
    const g = groupStatuses([
      { status: 'ORDER_PLACED', n: 2 }, { status: 'CONFIRMED', n: 1 }, { status: 'PREPARING', n: 4 },
      { status: 'PACKED', n: 3 }, { status: 'OUT_FOR_DELIVERY', n: 5 }, { status: 'PICKED_UP', n: 1 },
      { status: 'DELIVERED', n: 40 }, { status: 'CANCELLED', n: 6 }, { status: 'REFUNDED', n: 2 },
    ], 7)
    expect(g).toMatchObject({
      placed: 3, preparing: 4, packed: 3, out_for_delivery: 6, delivered: 40,
      cancelled: 6, refunded: 2, return_requested: 7, total: 64,
    })
  })
})

describe('deriveFinancials', () => {
  const base = {
    orders: 10, customers: 8, gross_revenue: '10000', discounts: '500', refunds: '700',
    delivery_revenue: '200', other_fee_revenue: '50', taxes: '100', collected: '9300',
    product_cost: '6000', rider_cost: '400', shiprocket_cost: '0', costed_orders: 5,
    costed_net_revenue: '4000', gross_profit: '1000', net_profit: '800',
  }
  it('derives net revenue, AOV and margins', () => {
    const f = deriveFinancials(base)
    expect(f.net_revenue).toBe(8800)
    expect(f.aov).toBe(930)
    expect(f.cost_coverage).toBe(0.5)
    expect(f.net_margin).toBeCloseTo(0.2)
  })
  it('never invents profit when no order is fully costed', () => {
    const f = deriveFinancials({ ...base, costed_orders: 0, costed_net_revenue: '0', gross_profit: '0', net_profit: '0' })
    expect(f.gross_profit).toBeNull()
    expect(f.net_profit).toBeNull()
    expect(f.net_margin).toBeNull()
  })
  it('handles an empty period', () => {
    const f = deriveFinancials({ orders: 0 })
    expect(f.aov).toBe(0)
    expect(f.cost_coverage).toBeNull()
  })
})

const product = (o) => ({
  product_id: 'p', name: 'P', units: 20, revenue: 2000, cogs: 1800, costed_revenue: 2000,
  buyers: 5, repeat_buyers: 0, repeat_revenue: 0, refunded_units: 0, refunded_value: 0, ...o,
})

describe('buildInsights', () => {
  it('flags a strong seller with thin margin and sizes the impact against the target margin', () => {
    const r = buildInsights({ netRevenue: 10000, products: [product({ product_id: 'a', name: 'Mutton' })] })
    const i = r.items.find((x) => x.id === 'low-margin:a')
    expect(i).toBeTruthy()
    // margin 10% → (20% - 10%) × 2000 = 200
    expect(i.impact_inr).toBe(200)
    expect(i.kind).toBe('leakage')
  })

  it('does not flag healthy margins or products without a cost price', () => {
    const healthy = product({ product_id: 'h', cogs: 1000 })
    const uncosted = product({ product_id: 'u', cogs: null, costed_revenue: null })
    const r = buildInsights({ netRevenue: 10000, products: [healthy, uncosted] })
    expect(r.items.some((x) => x.id.startsWith('low-margin'))).toBe(false)
  })

  it('flags high refund rates with the refunded value as impact', () => {
    const r = buildInsights({
      netRevenue: 10000,
      products: [product({ product_id: 'f', name: 'Fish', units: 10, refunded_units: 3, refunded_value: 900 })],
    })
    const i = r.items.find((x) => x.id === 'returns:f')
    expect(i.impact_inr).toBe(900)
  })

  it('ignores a high refund rate on a tiny sample', () => {
    const r = buildInsights({
      netRevenue: 10000,
      products: [product({ product_id: 'f', units: 2, refunded_units: 1, refunded_value: 100 })],
    })
    expect(r.items.some((x) => x.id === 'returns:f')).toBe(false)
  })

  it('flags areas whose delivery cost per order is well above average', () => {
    const r = buildInsights({
      netRevenue: 50000, deliveryCostPerOrder: 40,
      areas: [
        { pincode: '700002', orders: 20, net_revenue: 9000, delivery_cost: 1800, delivery_revenue: 0 }, // ₹90/order
        { pincode: '700001', orders: 20, net_revenue: 9000, delivery_cost: 800, delivery_revenue: 0 },  // ₹40/order
      ],
    })
    expect(r.items.find((x) => x.id === 'area-cost:700002').impact_inr).toBe(1000) // (90-40)×20
    expect(r.items.some((x) => x.id === 'area-cost:700001')).toBe(false)
  })

  it('flags vendor rejections and price premiums', () => {
    const r = buildInsights({
      netRevenue: 100000,
      vendors: [{ vendor_id: 'v1', name: 'V', received_value: 1000, rejected_value: 200 }],
      vendorPriceGaps: [{ vendor_id: 'v2', vendor_name: 'W', product_id: 'p', name: 'Chicken', qty: 10, unit_price: 260, peer_price: 200 }],
    })
    expect(r.items.find((x) => x.id === 'vendor-reject:v1').impact_inr).toBe(200)
    expect(r.items.find((x) => x.id === 'vendor-price:v2:p').impact_inr).toBe(600)
  })

  it('reports growth as an opportunity using the previous period', () => {
    const r = buildInsights({
      netRevenue: 10000,
      products: [product({ product_id: 'g', name: 'Prawns', revenue: 3000, units: 10 })],
      prevProducts: [product({ product_id: 'g', revenue: 1000, units: 4 })],
    })
    const i = r.items.find((x) => x.id === 'growth:g')
    expect(i.kind).toBe('opportunity')
    expect(i.impact_inr).toBe(2000)
  })

  it('explains missing cost data instead of guessing', () => {
    const r = buildInsights({ netRevenue: 1000, ordersCount: 10, costCoverage: 0.3, products: [] })
    expect(r.items.some((x) => x.id === 'data-cost-coverage')).toBe(true)
    expect(r.items.some((x) => x.id === 'data-untracked-costs')).toBe(true)
  })

  it('ranks leakage first by severity then impact and caps today\'s list at five', () => {
    const products = Array.from({ length: 8 }, (_, n) =>
      product({ product_id: `r${n}`, name: `R${n}`, cogs: 1000, units: 10, refunded_units: 2, refunded_value: 100 * (n + 1) }))
    const r = buildInsights({ netRevenue: 1000000, products })
    expect(r.investigate_today).toHaveLength(5)
    const impacts = r.items.filter((i) => i.kind === 'leakage').map((i) => i.impact_inr)
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a))
    expect(r.totals.leakage_count).toBe(8)
  })

  it('exposes its thresholds so the numbers are explainable', () => {
    expect(THRESHOLDS.TARGET_MARGIN).toBeGreaterThan(THRESHOLDS.LOW_MARGIN)
  })
})
