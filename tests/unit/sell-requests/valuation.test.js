import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, ValidationError, isValidImei, parseQa, valuate, variantBase } from '../../../src/modules/sell-requests/valuation.js'

const mint = { ageMonths: 3, screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 95, powersOn: true }

describe('valuate', () => {
  it('mint device → no deductions, base value, EXCELLENT', () => {
    const r = valuate(40000, mint)
    expect(r).toMatchObject({ value: 40000, condition: 'EXCELLENT', totalPct: 0, deductions: [] })
  })

  it('applies each answer and lists it', () => {
    const r = valuate(40000, { ...mint, screenScratches: 'MINOR', noBox: 1, boxAvailable: false, chargerAvailable: false })
    expect(r.deductions.map((d) => d.label)).toEqual(['Minor screen scratches', 'No box', 'No charger'])
    expect(r.totalPct).toBe(10)
    expect(r.value).toBe(36000)
    expect(r.condition).toBe('GOOD')
  })

  it('age is free for 6 months then capped', () => {
    expect(valuate(10000, { ...mint, ageMonths: 6 }).deductions).toEqual([])
    expect(valuate(10000, { ...mint, ageMonths: 12 }).totalPct).toBe(5)
    expect(valuate(10000, { ...mint, ageMonths: 120 }).totalPct).toBe(DEFAULT_RULES.ageMaxPct)
  })

  it('battery deduction only below the floor', () => {
    expect(valuate(10000, { ...mint, batteryHealth: 85 }).deductions).toEqual([])
    expect(valuate(10000, { ...mint, batteryHealth: 75 }).totalPct).toBe(5)
  })

  it('total deduction is capped and value never negative', () => {
    const worst = { ageMonths: 120, screenScratches: 'MAJOR', bodyDents: true, screenReplaced: true, skinReplaced: true, billAvailable: false, boxAvailable: false, chargerAvailable: false, batteryHealth: 40, powersOn: false }
    const r = valuate(50000, worst)
    expect(r.totalPct).toBe(85)
    expect(r.value).toBe(7500)
    expect(r.condition).toBe('POOR')
  })

  it('honours rule overrides from settings', () => {
    const r = valuate(10000, { ...mint, bodyDents: true }, { bodyDents: 20 })
    expect(r.totalPct).toBe(20)
  })

  it('rounds the quote to the nearest ₹100', () => {
    expect(valuate(12345, { ...mint, screenScratches: 'MINOR' }).value % 100).toBe(0)
  })
})

describe('variantBase', () => {
  it('top variant is the base; lower variants step down', () => {
    const v = ['128GB', '256GB', '512GB']
    expect(variantBase(50000, v, '512GB')).toBe(50000)
    expect(variantBase(50000, v, '256GB')).toBe(46000)
    expect(variantBase(50000, v, '128GB')).toBe(42000)
  })
  it('rejects an unknown variant', () => {
    expect(() => variantBase(1000, ['a'], 'b')).toThrow(ValidationError)
  })
})

describe('parseQa', () => {
  it('accepts a valid payload', () => {
    expect(parseQa(mint)).toEqual(mint)
  })
  it.each([
    [{ ...mint, ageMonths: -1 }],
    [{ ...mint, ageMonths: 1.5 }],
    [{ ...mint, batteryHealth: 10 }],
    [{ ...mint, screenScratches: 'DEEP' }],
    [{ ...mint, powersOn: 'yes' }],
    [null],
  ])('rejects %j', (bad) => {
    expect(() => parseQa(bad)).toThrow(ValidationError)
  })
})

describe('isValidImei', () => {
  it('accepts a Luhn-valid 15-digit IMEI', () => expect(isValidImei('490154203237518')).toBe(true))
  it('rejects bad checksum, length and non-digits', () => {
    expect(isValidImei('490154203237519')).toBe(false)
    expect(isValidImei('49015420323751')).toBe(false)
    expect(isValidImei('49015420323751a')).toBe(false)
  })
})
