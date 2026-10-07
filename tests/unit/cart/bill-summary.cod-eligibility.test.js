import { describe, expect, it } from 'vitest'

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Regression coverage for the "COD works backwards above ₹99" bug report
 * (2026-07-02): admin wanted cod_min_order_amount=99 (a MINIMUM), but the
 * effective behavior looked like a MAXIMUM — COD unavailable above ₹99.
 *
 * Root cause: cod_min_order_amount and cod_max_amount are two separate,
 * correctly-implemented fields; the bug was that cod_max_amount got set to
 * 99 via a confusing duplicate settings surface (see migration 065), which
 * collapses the valid COD window to a single rupee value. The comparison
 * logic in _buildPaymentMethods itself (< min / > max) is exercised here
 * directly across the full boundary space, both positive and negative, so
 * any future change to this method is caught immediately.
 */

function service() {
  // BillSummaryService only touches the DB in getBillSummary(); the method
  // under test, _buildPaymentMethods, is pure given a config + total, so a
  // bare instance (no real repositories ever invoked) is safe here.
  return new BillSummaryService({})
}

function codConfig(overrides = {}) {
  return {
    codEnabled: true,
    codMinOrderAmount: 99,
    codMaxOrderAmount: 2000,
    razorpayEnabled: true,
    walletEnabled: true,
    ...overrides,
  }
}

describe('BillSummaryService — COD min/max eligibility', () => {
  it('is unavailable below the minimum (negative)', () => {
    const { cod } = service()._buildPaymentMethods(codConfig({ codMinOrderAmount: 99 }), 50)
    expect(cod.available).toBe(false)
    expect(cod.reason).toMatch(/more to use Cash on Delivery/i)
  })

  it('is available exactly at the minimum (positive boundary)', () => {
    const { cod } = service()._buildPaymentMethods(codConfig({ codMinOrderAmount: 99 }), 99)
    expect(cod.available).toBe(true)
  })

  it('is available for a normal order comfortably between min and max (positive)', () => {
    const { cod } = service()._buildPaymentMethods(
      codConfig({ codMinOrderAmount: 99, codMaxOrderAmount: 2000 }),
      500
    )
    expect(cod.available).toBe(true)
    expect(cod.reason).toBeNull()
  })

  it('is available exactly at the maximum (positive boundary)', () => {
    const { cod } = service()._buildPaymentMethods(codConfig({ codMaxOrderAmount: 2000 }), 2000)
    expect(cod.available).toBe(true)
  })

  it('is unavailable above the maximum (negative)', () => {
    const { cod } = service()._buildPaymentMethods(codConfig({ codMaxOrderAmount: 2000 }), 2001)
    expect(cod.available).toBe(false)
    expect(cod.reason).toMatch(/isn't available above/i)
  })

  it('is unavailable when COD is globally disabled, regardless of amount (negative)', () => {
    const { cod } = service()._buildPaymentMethods(codConfig({ codEnabled: false }), 500)
    expect(cod.available).toBe(false)
    expect(cod.reason).toMatch(/currently unavailable/i)
  })

  it('has no upper bound when codMaxOrderAmount is null (positive — large order still allowed)', () => {
    const { cod } = service()._buildPaymentMethods(
      codConfig({ codMinOrderAmount: 99, codMaxOrderAmount: null }),
      50000
    )
    expect(cod.available).toBe(true)
  })

  it(
    'reproduces the exact reported bug state (min=99, max=99) and documents why it breaks COD ' +
      'for every order above ₹99 — this is the collapsed-window symptom the migration repairs',
    () => {
      const belowNinetyNine = service()._buildPaymentMethods(
        codConfig({ codMinOrderAmount: 99, codMaxOrderAmount: 99 }),
        50
      )
      expect(belowNinetyNine.cod.available).toBe(false) // below min

      const exactlyNinetyNine = service()._buildPaymentMethods(
        codConfig({ codMinOrderAmount: 99, codMaxOrderAmount: 99 }),
        99
      )
      expect(exactlyNinetyNine.cod.available).toBe(true) // the only value that works

      const aboveNinetyNine = service()._buildPaymentMethods(
        codConfig({ codMinOrderAmount: 99, codMaxOrderAmount: 99 }),
        100
      )
      expect(aboveNinetyNine.cod.available).toBe(false) // matches "not available above ₹99"
    }
  )

  it('a healthy min/max window (99 / 2000) keeps COD available across the whole realistic order range (positive)', () => {
    for (const total of [99, 150, 500, 999, 1999, 2000]) {
      const { cod } = service()._buildPaymentMethods(codConfig({ codMinOrderAmount: 99, codMaxOrderAmount: 2000 }), total)
      expect(cod.available).toBe(true)
    }
  })
})
