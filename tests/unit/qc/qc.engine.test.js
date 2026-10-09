import { describe, expect, it } from 'vitest'
import { evaluateQc, isValidImei } from '../../../src/modules/qc/qc.engine.js'

const rule = (key, o = {}) => ({ key, label: key, enabled: true, required: false, weight: 10, params: {}, ...o })
const ctx = (o = {}) => ({
  listing: {
    price: 50000, mrp: 60000, imageCount: 4, condition: 'NEW', conditionNotes: '', batteryHealth: null,
    serialNumber: 'SN12345', imei: '490154203237518', warrantyInfo: '1 year', categoryName: 'Smartphones', ...o.listing,
  },
  invoices: o.invoices ?? [{ status: 'VERIFIED', imei_serial: '490154203237518' }],
  vendor: o.vendor === undefined ? { status: 'ACTIVE' } : o.vendor,
})
const settings = { passThreshold: 80 }
const byKey = (out, k) => out.results.find((r) => r.key === k)

describe('isValidImei', () => {
  it('accepts a Luhn-valid 15-digit IMEI and rejects bad ones', () => {
    expect(isValidImei('490154203237518')).toBe(true)
    expect(isValidImei('49-015420-323751-8')).toBe(true)
    expect(isValidImei('490154203237519')).toBe(false)
    expect(isValidImei('12345')).toBe(false)
    expect(isValidImei('')).toBe(false)
  })
})

describe('evaluateQc rules', () => {
  it('IMEI: skipped outside phone categories, fails when missing/invalid/mismatching', () => {
    const r = [rule('IMEI', { params: { categoryKeywords: ['phone'] } })]
    expect(byKey(evaluateQc(ctx({ listing: { categoryName: 'Laptops' } }), r, settings), 'IMEI').status).toBe('SKIP')
    expect(byKey(evaluateQc(ctx({ listing: { imei: '' } }), r, settings), 'IMEI').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ listing: { imei: '490154203237519' } }), r, settings), 'IMEI').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ invoices: [{ status: 'VERIFIED', imei_serial: '356938035643809' }] }), r, settings), 'IMEI').detail)
      .toMatch(/does not match the invoice/)
    expect(byKey(evaluateQc(ctx(), r, settings), 'IMEI').status).toBe('PASS')
  })

  it('IMAGES: needs the configured minimum', () => {
    const r = [rule('IMAGES', { params: { minImages: 3 } })]
    expect(byKey(evaluateQc(ctx({ listing: { imageCount: 2 } }), r, settings), 'IMAGES').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ listing: { imageCount: 3 } }), r, settings), 'IMAGES').status).toBe('PASS')
  })

  it('INVOICE: none fails, uploaded-but-unverified fails when verification is required, verified passes, rejected ignored', () => {
    const r = [rule('INVOICE', { params: { requireVerified: true } })]
    expect(byKey(evaluateQc(ctx({ invoices: [] }), r, settings), 'INVOICE').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ invoices: [{ status: 'UPLOADED' }] }), r, settings), 'INVOICE').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ invoices: [{ status: 'REJECTED' }] }), r, settings), 'INVOICE').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ invoices: [{ status: 'VERIFIED' }] }), r, settings), 'INVOICE').status).toBe('PASS')
    const lax = [rule('INVOICE', { params: { requireVerified: false } })]
    expect(byKey(evaluateQc(ctx({ invoices: [{ status: 'UPLOADED' }] }), lax, settings), 'INVOICE').status).toBe('PASS')
  })

  it('CONDITION: used items need notes; very low battery fails', () => {
    const r = [rule('CONDITION', { params: { minNoteLength: 10 } })]
    expect(byKey(evaluateQc(ctx(), r, settings), 'CONDITION').status).toBe('SKIP')
    expect(byKey(evaluateQc(ctx({ listing: { condition: 'USED_GOOD', conditionNotes: 'scratches' } }), r, settings), 'CONDITION').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ listing: { condition: 'USED_GOOD', conditionNotes: 'light scratches on back', batteryHealth: 40 } }), r, settings), 'CONDITION').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ listing: { condition: 'USED_GOOD', conditionNotes: 'light scratches on back', batteryHealth: 88 } }), r, settings), 'CONDITION').status).toBe('PASS')
  })

  it('PRICE_RANGE: compares the price with MRP', () => {
    const r = [rule('PRICE_RANGE', { params: { minPctOfMrp: 30, maxPctOfMrp: 100 } })]
    expect(byKey(evaluateQc(ctx({ listing: { price: 10000, mrp: 60000 } }), r, settings), 'PRICE_RANGE').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ listing: { price: 70000, mrp: 60000 } }), r, settings), 'PRICE_RANGE').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ listing: { price: 50000, mrp: 60000 } }), r, settings), 'PRICE_RANGE').status).toBe('PASS')
    expect(byKey(evaluateQc(ctx({ listing: { mrp: null } }), r, settings), 'PRICE_RANGE').status).toBe('SKIP')
  })

  it('REQUIRED_DOCUMENTS, SERIAL_NUMBER and SELLER_INFO', () => {
    expect(byKey(evaluateQc(ctx({ invoices: [], listing: { warrantyInfo: '' } }), [rule('REQUIRED_DOCUMENTS', { params: {} })], settings), 'REQUIRED_DOCUMENTS').detail)
      .toBe('Missing: invoice, warranty details')
    expect(byKey(evaluateQc(ctx({ listing: { serialNumber: '' } }), [rule('SERIAL_NUMBER', { params: {} })], settings), 'SERIAL_NUMBER').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ vendor: { status: 'SUSPENDED' } }), [rule('SELLER_INFO')], settings), 'SELLER_INFO').status).toBe('FAIL')
    expect(byKey(evaluateQc(ctx({ vendor: null }), [rule('SELLER_INFO')], settings), 'SELLER_INFO').status).toBe('SKIP')
  })
})

describe('evaluateQc decision', () => {
  const rules = [
    rule('IMAGES', { required: true, weight: 50, params: { minImages: 3 } }),
    rule('SERIAL_NUMBER', { weight: 50, params: {} }),
  ]
  it('a failed required rule means QC_FAILED regardless of score', () => {
    const out = evaluateQc(ctx({ listing: { imageCount: 1 } }), rules, settings)
    expect(out.status).toBe('QC_FAILED')
    expect(out.requiredFailed).toEqual(['IMAGES'])
    expect(out.score).toBe(50)
  })
  it('score at or above the threshold passes; below it asks for a recheck', () => {
    expect(evaluateQc(ctx(), rules, settings).status).toBe('QC_PASSED')
    const out = evaluateQc(ctx({ listing: { serialNumber: '' } }), rules, settings)
    expect(out.score).toBe(50)
    expect(out.status).toBe('QC_RECHECK')
    expect(evaluateQc(ctx({ listing: { serialNumber: '' } }), rules, { passThreshold: 50 }).status).toBe('QC_PASSED')
  })
  it('skipped rules do not count against the score; disabled rules are ignored', () => {
    const out = evaluateQc(ctx({ vendor: null }), [rule('SELLER_INFO', { weight: 90 }), rule('IMAGES', { weight: 10, params: { minImages: 3 } }), rule('SERIAL_NUMBER', { enabled: false })], settings)
    expect(out.score).toBe(100)
    expect(out.results.map((r) => r.key)).toEqual(['SELLER_INFO', 'IMAGES'])
  })
})
