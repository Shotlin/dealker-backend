import { describe, expect, it } from 'vitest'
import { STATES, amountInWords, computeDocument, financialYear, stateCodeFromGstin, stateCodeFromName } from '../../src/modules/sales-invoices/invoice-tax.js'

const line = (o = {}) => ({ description: 'x', hsnSac: '8517', qty: 1, unitPrice: 1000, taxRate: 18, ...o })

describe('GST split', () => {
  it('intra-state: CGST + SGST, each half of the tax', () => {
    const d = computeDocument([line()], { supply: 'INTRA' })
    expect(d).toMatchObject({ taxable: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 })
  })

  it('inter-state: IGST only', () => {
    const d = computeDocument([line()], { supply: 'INTER' })
    expect(d).toMatchObject({ taxable: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180 })
  })

  it('odd paise never leak: CGST + SGST always equals the line tax', () => {
    const d = computeDocument([line({ unitPrice: 33.33, qty: 3, taxRate: 5 })], { supply: 'INTRA' })   // tax = 5.00 (499.95*5%=4.9995→5.00)
    expect(Math.round((d.cgst + d.sgst) * 100)).toBe(Math.round(d.taxable * 5))
    const o = computeDocument([line({ unitPrice: 0.01, qty: 1, taxRate: 18 })], { supply: 'INTRA' })
    expect(Math.round((o.cgst + o.sgst + o.taxable) * 100)).toBe(Math.round(o.total * 100))
  })

  it('totals are the sum of the rounded lines, so a printed invoice always adds up', () => {
    const d = computeDocument(Array.from({ length: 7 }, (_, i) => line({ unitPrice: 19.99 + i, qty: 3, taxRate: 12 })), { supply: 'INTRA' })
    const sum = (k) => Math.round(d.lines.reduce((n, l) => n + l[k] * 100, 0))
    expect(Math.round(d.taxable * 100)).toBe(sum('taxable'))
    expect(Math.round(d.total * 100)).toBe(sum('total'))
    expect(Math.round(d.cgst * 100)).toBe(sum('cgst'))
    expect(Math.round(d.total * 100)).toBe(Math.round((d.taxable + d.cgst + d.sgst + d.igst) * 100))
  })

  it('discount reduces the taxable value, not the tax rate', () => {
    const d = computeDocument([line({ discount: 200 })], { supply: 'INTER' })
    expect(d).toMatchObject({ taxable: 800, igst: 144, total: 944 })
    expect(() => computeDocument([line({ discount: 1500 })], { supply: 'INTER' })).toThrow(RangeError)
  })

  it('tax-inclusive prices back the tax out instead of adding it again', () => {
    const d = computeDocument([line({ unitPrice: 1180 })], { supply: 'INTRA', taxInclusive: true })
    expect(d).toMatchObject({ taxable: 1000, cgst: 90, sgst: 90, total: 1180 })
    const odd = computeDocument([line({ unitPrice: 199 })], { supply: 'INTER', taxInclusive: true })
    expect(odd.total).toBe(199)                            // what the customer paid is what is invoiced
    expect(odd.taxable + odd.igst).toBeCloseTo(199, 2)
  })

  it('zero-rated and mixed-rate lines group correctly in the HSN summary', () => {
    const d = computeDocument([line(), line({ unitPrice: 500 }), line({ hsnSac: '9987', taxRate: 0 }), line({ hsnSac: '7007', taxRate: 12 })], { supply: 'INTRA' })
    expect(d.taxSummary).toHaveLength(3)
    expect(d.taxSummary.find((g) => g.hsnSac === '8517')).toMatchObject({ taxable: 1500, cgst: 135, sgst: 135 })
    expect(d.taxSummary.find((g) => g.taxRate === 0)).toMatchObject({ cgst: 0, sgst: 0, igst: 0 })
  })

  it('a pre-computed taxable value (credit notes) carries the original rate', () => {
    const d = computeDocument([{ description: 'x', qty: 1, taxRate: 18, taxablePaise: 33333, unitPrice: 0 }], { supply: 'INTRA' })
    expect(d.taxable).toBe(333.33)
    expect(Math.round((d.cgst + d.sgst) * 100)).toBe(Math.round(33333 * 0.18))
  })
})

describe('places and years', () => {
  it('maps GSTINs and state names to codes', () => {
    expect(stateCodeFromGstin('29ABCDE1234F1Z5')).toBe('29')
    expect(stateCodeFromGstin('29ABCDE1234F1')).toBeNull()
    expect(stateCodeFromGstin('99ABCDE1234F1Z5')).toBeNull()
    expect(stateCodeFromName('Kerala')).toBe('32')
    expect(stateCodeFromName('  west bengal ')).toBe('19')
    expect(stateCodeFromName('Orissa')).toBe('21')
    expect(stateCodeFromName('Atlantis')).toBeNull()
    expect(Object.keys(STATES)).toHaveLength(Object.values(STATES).length)
  })

  it('Indian financial year rolls over on 1 April', () => {
    expect(financialYear('2026-03-31T00:00:00Z')).toBe('25-26')
    expect(financialYear('2026-04-01T00:00:00Z')).toBe('26-27')
    expect(financialYear('2026-12-31T00:00:00Z')).toBe('26-27')
    expect(financialYear('2027-01-01T00:00:00Z')).toBe('26-27')
  })

  it('writes amounts in Indian words', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only')
    expect(amountInWords(2360)).toBe('Rupees Two Thousand Three Hundred Sixty Only')
    expect(amountInWords(1250.5)).toBe('Rupees One Thousand Two Hundred Fifty and Fifty Paise Only')
    expect(amountInWords(10000000)).toBe('Rupees One Crore Only')
    expect(amountInWords(123456789.12)).toBe('Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Twelve Paise Only')
  })
})
