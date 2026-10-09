import { describe, expect, it } from 'vitest'
import { STATUSES, TABS, TRANSITIONS, advanceFor, canMove, computeQuote, settle, warrantyUntil } from '../../src/modules/repairs/repairs.engine.js'

describe('repair lifecycle', () => {
  it('follows the intended happy path, one step at a time', () => {
    const path = ['REQUESTED', 'ACCEPTED', 'INSPECTION', 'ESTIMATE_SENT', 'ESTIMATE_APPROVED', 'IN_REPAIR', 'QC_PENDING', 'REPAIRED', 'READY_FOR_DELIVERY', 'COMPLETED']
    for (let i = 0; i < path.length - 1; i++) expect(canMove(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`).toBe(true)
  })

  it('refuses every skipped step', () => {
    const bad = [['REQUESTED', 'IN_REPAIR'], ['REQUESTED', 'COMPLETED'], ['ACCEPTED', 'IN_REPAIR'], ['INSPECTION', 'IN_REPAIR'], ['ESTIMATE_SENT', 'IN_REPAIR'],
      ['ESTIMATE_APPROVED', 'COMPLETED'], ['IN_REPAIR', 'REPAIRED'], ['IN_REPAIR', 'COMPLETED'], ['QC_PENDING', 'COMPLETED'], ['REPAIRED', 'COMPLETED'], ['CANCELLED', 'REQUESTED'], ['REJECTED', 'ACCEPTED']]
    for (const [a, b] of bad) expect(canMove(a, b), `${a} → ${b}`).toBe(false)
  })

  it('supports rejection, cancellation, failure, rework and warranty reopen explicitly', () => {
    expect(canMove('REQUESTED', 'REJECTED')).toBe(true)
    expect(canMove('ACCEPTED', 'CANCELLED')).toBe(true)
    expect(canMove('ESTIMATE_SENT', 'ESTIMATE_REJECTED')).toBe(true)
    expect(canMove('IN_REPAIR', 'FAILED')).toBe(true)
    expect(canMove('QC_PENDING', 'IN_REPAIR')).toBe(true)
    expect(canMove('COMPLETED', 'IN_REPAIR')).toBe(true)
    // once the device is in the shop, cancelling is not possible: it returns via estimate rejection or failure
    expect(canMove('INSPECTION', 'CANCELLED')).toBe(false)
    expect(canMove('ESTIMATE_REJECTED', 'READY_FOR_DELIVERY')).toBe(true)
    expect(canMove('FAILED', 'READY_FOR_DELIVERY')).toBe(true)
  })

  it('knows every status, and each queue only lists real ones', () => {
    for (const s of Object.keys(TRANSITIONS)) expect(STATUSES).toContain(s)
    for (const list of Object.values(TABS)) for (const s of list) expect(STATUSES).toContain(s)
    expect(STATUSES.every((s) => s in TRANSITIONS)).toBe(true)
  })
})

describe('quote maths', () => {
  const line = (unitPrice, qty = 1) => ({ kind: 'LABOUR', description: 'x', qty, unitPrice })

  it('applies discount before tax', () => {
    const q = computeQuote({ lines: [line(800), line(1200)], discountPct: 10, taxPct: 18 })
    expect(q.subtotal).toBe(2000)
    expect(q.discountAmount).toBe(200)
    expect(q.taxable).toBe(1800)
    expect(q.taxAmount).toBe(324)
    expect(q.total).toBe(2124)
  })

  it('does not drift on awkward decimals', () => {
    const q = computeQuote({ lines: [line(0.1), line(0.2)], taxPct: 0 })
    expect(q.total).toBe(0.3)
    const r = computeQuote({ lines: [line(33.33, 3)], taxPct: 18 })
    expect(r.subtotal).toBe(99.99)
    expect(r.taxAmount).toBe(18)
    expect(r.total).toBe(117.99)
  })

  it('multiplies by quantity and handles free lines', () => {
    const q = computeQuote({ lines: [line(250, 4), line(0)], taxPct: 18 })
    expect(q.lines[0].amount).toBe(1000)
    expect(q.total).toBe(1180)
  })

  it('computes advance and commission in whole paise', () => {
    expect(advanceFor(2124, 30)).toBe(637.2)
    expect(advanceFor(999.99, 10)).toBe(100)
    expect(settle({ taxable: 1800, commissionPct: 10 })).toEqual({ commission: 180, vendorPayable: 1620 })
    const s = settle({ taxable: 333.33, commissionPct: 12.5 })
    expect(Math.round((s.commission + s.vendorPayable) * 100)).toBe(33333)
  })

  it('adds warranty days across month ends', () => {
    expect(warrantyUntil('2026-01-31T10:00:00Z', 30)).toBe('2026-03-02')
  })
})
