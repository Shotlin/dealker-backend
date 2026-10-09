import { describe, expect, it } from 'vitest'
import { calculateSellerOrder, feesForAmount, resolveRule } from '../../../src/modules/commission/commission.engine.js'

const rule = (o) => ({
  id: o.id || Math.random().toString(36), scope: 'GLOBAL', channel: 'ALL', is_active: true,
  commission_pct: 0, platform_charge_flat: 0, platform_charge_pct: 0, tax_pct: 0, ...o,
})

describe('resolveRule', () => {
  const rules = [
    rule({ id: 'g', scope: 'GLOBAL', commission_pct: 10 }),
    rule({ id: 'v', scope: 'VENDOR', vendor_id: 'V1', commission_pct: 8 }),
    rule({ id: 'c', scope: 'CATEGORY', category_id: 'C1', commission_pct: 6 }),
    rule({ id: 'p', scope: 'PRODUCT', product_id: 'P1', commission_pct: 4 }),
    rule({ id: 'vb2b', scope: 'VENDOR', vendor_id: 'V1', channel: 'B2B', commission_pct: 3 }),
  ]
  it('PRODUCT beats CATEGORY beats VENDOR beats GLOBAL', () => {
    const ctx = { vendorId: 'V1', categoryId: 'C1', productId: 'P1', channel: 'B2C' }
    expect(resolveRule(rules, ctx).id).toBe('p')
    expect(resolveRule(rules, { ...ctx, productId: 'X' }).id).toBe('c')
    expect(resolveRule(rules, { ...ctx, productId: 'X', categoryId: 'X' }).id).toBe('v')
    expect(resolveRule(rules, { vendorId: 'X', channel: 'B2C' }).id).toBe('g')
  })
  it('channel-specific rule wins inside the same scope, and never leaks across channels', () => {
    const ctx = { vendorId: 'V1', channel: 'B2B' }
    expect(resolveRule(rules, ctx).id).toBe('vb2b')
    expect(resolveRule(rules, { vendorId: 'V1', channel: 'B2C' }).id).toBe('v')
  })
  it('ignores inactive rules and returns null when nothing matches', () => {
    expect(resolveRule([rule({ scope: 'VENDOR', vendor_id: 'V1', is_active: false })], { vendorId: 'V1', channel: 'B2C' })).toBeNull()
  })
})

describe('feesForAmount', () => {
  it('5% commission on ₹50,000 with 2% platform charge and 18% tax on fees', () => {
    const f = feesForAmount(50000, rule({ commission_pct: 5, platform_charge_pct: 2, tax_pct: 18 }))
    expect(f.commission).toBe(2500)
    expect(f.platformCharge).toBe(1000)
    expect(f.tax).toBe(630) // 18% of 3500
  })
  it('no rule means zero fees', () => {
    expect(feesForAmount(1000, null)).toMatchObject({ commission: 0, platformCharge: 0, tax: 0 })
  })
})

describe('calculateSellerOrder', () => {
  it('Selling Price → Commission → Platform Charge → Tax → Vendor Net', () => {
    const r = calculateSellerOrder({
      vendorId: 'V1', channel: 'B2C',
      rules: [rule({ scope: 'VENDOR', vendor_id: 'V1', commission_pct: 5, platform_charge_flat: 20, tax_pct: 18 })],
      items: [{ lineTotal: 1000 }, { lineTotal: 500 }],
    })
    expect(r.sellingPrice).toBe(1500)
    expect(r.commission).toBe(75)
    expect(r.platformCharge).toBe(20) // flat charge once per order, not per line
    expect(r.tax).toBe(17.1) // 18% of (75 + 20)
    expect(r.vendorNet).toBe(1387.9)
    expect(r.effectiveRate).toBe(5)
  })
  it('applies seller discount share before fees', () => {
    const r = calculateSellerOrder({
      vendorId: 'V1', rules: [rule({ commission_pct: 10 })],
      items: [{ lineTotal: 1000, discountShare: 100 }],
    })
    expect(r.sellingPrice).toBe(900)
    expect(r.commission).toBe(90)
  })
  it('mixed categories use per-item rules', () => {
    const r = calculateSellerOrder({
      vendorId: 'V1',
      rules: [rule({ commission_pct: 10 }), rule({ scope: 'CATEGORY', category_id: 'C1', commission_pct: 2 })],
      items: [{ lineTotal: 1000, categoryId: 'C1' }, { lineTotal: 1000, categoryId: 'C2' }],
    })
    expect(r.commission).toBe(120) // 20 + 100
    expect(r.effectiveRate).toBe(6)
  })
})
