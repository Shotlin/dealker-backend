import { describe, expect, it } from 'vitest'
import {
  applyRounding, computePrice, computeStock, summarise, validatePriceParams, validateStockParams,
} from '../../../src/modules/pricing/price.engine.js'

const row = (o = {}) => ({ old: 50000, mrp: 60000, cost: 40000, field: 'sale_price', ...o })

describe('validatePriceParams', () => {
  it('accepts the common reductions the admin asked for (-1%, -2%, -5%)', () => {
    for (const v of [-1, -2, -5]) expect(validatePriceParams({ operation: 'PERCENT', value: v })).toBeNull()
  })
  it('rejects zero, ≥100% cuts and large swings unless allowed', () => {
    expect(validatePriceParams({ operation: 'PERCENT', value: 0 })).toMatch(/cannot be 0/)
    expect(validatePriceParams({ operation: 'PERCENT', value: -100 })).toMatch(/zero/)
    expect(validatePriceParams({ operation: 'PERCENT', value: -60 })).toMatch(/allow large change/)
    expect(validatePriceParams({ operation: 'PERCENT', value: -60, allowLargeChange: true })).toBeNull()
  })
  it('validates the other operations', () => {
    expect(validatePriceParams({ operation: 'NOPE', value: 1 })).toMatch(/operation/)
    expect(validatePriceParams({ operation: 'FIXED', value: 0 })).toMatch(/cannot be 0/)
    expect(validatePriceParams({ operation: 'SET', value: -5 })).toMatch(/greater than 0/)
    expect(validatePriceParams({ operation: 'DISCOUNT_FROM_MRP', value: 99 })).toMatch(/0 and 95/)
    expect(validatePriceParams({ operation: 'PERCENT', value: 'x' })).toMatch(/number/)
    expect(validatePriceParams({ operation: 'PERCENT', value: -1, rounding: 'WEIRD' })).toMatch(/rounding/)
  })
})

describe('computePrice', () => {
  it('percent change: -5% of ₹50,000 is ₹47,500', () => {
    expect(computePrice(row(), { operation: 'PERCENT', value: -5 })).toEqual({ value: 47500 })
  })
  it('fixed change and set price', () => {
    expect(computePrice(row(), { operation: 'FIXED', value: -1000 })).toEqual({ value: 49000 })
    expect(computePrice(row(), { operation: 'SET', value: 45000 })).toEqual({ value: 45000 })
  })
  it('discount from MRP: 25% off ₹60,000 is ₹45,000, and needs an MRP', () => {
    expect(computePrice(row(), { operation: 'DISCOUNT_FROM_MRP', value: 25 })).toEqual({ value: 45000 })
    expect(computePrice(row({ mrp: null }), { operation: 'DISCOUNT_FROM_MRP', value: 25 }).skip).toMatch(/No MRP/)
  })
  it('rounds as asked', () => {
    expect(applyRounding(47499.4, 'RUPEE')).toBe(47499)
    expect(applyRounding(47496, 'TEN')).toBe(47500)
    expect(applyRounding(47499.456, 'NONE')).toBe(47499.46)
    expect(computePrice(row({ old: 999, cost: null }), { operation: 'PERCENT', value: -1, rounding: 'RUPEE' })).toEqual({ value: 989 })
  })
  it('skips unsafe rows with a reason', () => {
    expect(computePrice(row(), { operation: 'PERCENT', value: 25 }).skip).toMatch(/above the MRP/)
    expect(computePrice(row(), { operation: 'PERCENT', value: -30 }).skip).toMatch(/below cost/)
    expect(computePrice(row(), { operation: 'PERCENT', value: -30, allowBelowCost: true })).toEqual({ value: 35000 })
    expect(computePrice(row({ old: 1 }), { operation: 'FIXED', value: -5 }).skip).toMatch(/below ₹1/)
    expect(computePrice(row(), { operation: 'SET', value: 50000 }).skip).toMatch(/not change/)
  })
  it('wholesale prices are not capped by the retail MRP', () => {
    expect(computePrice(row({ field: 'wholesale_price', old: 55000, mrp: 60000 }), { operation: 'PERCENT', value: 10 })).toEqual({ value: 60500 })
  })
})

describe('stock', () => {
  it('validates', () => {
    expect(validateStockParams({ operation: 'SET', value: 0 })).toBeNull()
    expect(validateStockParams({ operation: 'ADD', value: 0 })).toMatch(/cannot be 0/)
    expect(validateStockParams({ operation: 'ADD', value: 1.5 })).toMatch(/whole number/)
    expect(validateStockParams({ operation: 'X', value: 1 })).toMatch(/operation/)
  })
  it('set / add / subtract with guards', () => {
    expect(computeStock({ old: 5 }, { operation: 'SET', value: 10 })).toEqual({ value: 10 })
    expect(computeStock({ old: 5 }, { operation: 'ADD', value: 3 })).toEqual({ value: 8 })
    expect(computeStock({ old: 5 }, { operation: 'SUBTRACT', value: 2 })).toEqual({ value: 3 })
    expect(computeStock({ old: 1 }, { operation: 'SUBTRACT', value: 2 }).skip).toMatch(/below zero/)
    expect(computeStock({ old: 1, used: true }, { operation: 'ADD', value: 4 }).skip).toMatch(/single-unit/)
    expect(computeStock({ old: 5 }, { operation: 'SET', value: 5 }).skip).toMatch(/not change/)
  })
})

describe('summarise', () => {
  it('counts changed, skipped and groups reasons', () => {
    const s = summarise([{ value: 1 }, { skip: 'New price ₹10 would be below cost ₹20' }, { skip: 'New price ₹11 would be below cost ₹20' }])
    expect(s).toMatchObject({ total: 3, changed: 1, skipped: 2 })
    expect(Object.values(s.skipReasons)).toEqual([2])
  })
})
