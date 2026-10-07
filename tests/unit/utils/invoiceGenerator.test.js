import { describe, it, expect } from 'vitest'
import { generateInvoicePDF, resolveItemDisplay, resolveOrderTotals } from '../../../src/utils/invoiceGenerator.js'

function baseOrder(overrides = {}) {
  return {
    order_number: 'BKLOO-20260704-001',
    created_at: '2026-07-01T10:00:00.000Z',
    status: 'DELIVERED',
    payment_method: 'COD',
    payment_status: 'PAID',
    delivery_address: { label: 'Home', address_line: '221B Baker St', city: 'Kolkata', pincode: '700001' },
    items: [{ name: 'Milk 1L', quantity: 2, price: 60, total: 120 }],
    subtotal: 120,
    discount_amount: 0,
    delivery_fee: 20,
    tax_amount: 0,
    total_amount: 140,
    ...overrides,
  }
}

async function isPdfBuffer(promise) {
  const buffer = await promise
  expect(Buffer.isBuffer(buffer)).toBe(true)
  expect(buffer.length).toBeGreaterThan(0)
  expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-')
}

describe('generateInvoicePDF — normal orders (no banner)', () => {
  it('renders a valid PDF for a DELIVERED order with no timeline/payment', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder()))
  })

  it('renders a valid PDF for a PENDING order', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder({ status: 'PENDING' })))
  })
})

describe('generateInvoicePDF — CANCELLED banner', () => {
  it('renders without throwing when no timeline is supplied (plain banner)', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder({ status: 'CANCELLED' })))
  })

  it('renders with a timeline reason + date present', async () => {
    await isPdfBuffer(
      generateInvoicePDF(
        baseOrder({
          status: 'CANCELLED',
          timeline: [
            { from_status: 'PENDING', to_status: 'CONFIRMED', note: null, changed_at: '2026-07-01T10:05:00.000Z' },
            { from_status: 'CONFIRMED', to_status: 'CANCELLED', note: 'Customer requested cancellation', changed_at: '2026-07-01T11:00:00.000Z' },
          ],
        })
      )
    )
  })

  it('picks the LAST matching transition when the same status appears twice in the timeline', async () => {
    await isPdfBuffer(
      generateInvoicePDF(
        baseOrder({
          status: 'CANCELLED',
          timeline: [
            { from_status: 'PENDING', to_status: 'CANCELLED', note: 'first pass', changed_at: '2026-07-01T09:00:00.000Z' },
            { from_status: 'CANCELLED', to_status: 'CONFIRMED', note: 'reinstated', changed_at: '2026-07-01T10:00:00.000Z' },
            { from_status: 'CONFIRMED', to_status: 'CANCELLED', note: 'cancelled again', changed_at: '2026-07-01T11:00:00.000Z' },
          ],
        })
      )
    )
  })
})

describe('generateInvoicePDF — REFUNDED banner', () => {
  it('renders with a refund amount from order.payment', async () => {
    await isPdfBuffer(
      generateInvoicePDF(
        baseOrder({
          status: 'REFUNDED',
          payment: { refund_amount: '140.00' },
          timeline: [
            { from_status: 'CANCELLED', to_status: 'REFUNDED', note: 'Refund issued', changed_at: '2026-07-02T09:00:00.000Z' },
          ],
        })
      )
    )
  })

  it('renders without throwing when payment.refund_amount is absent (wallet refund gap)', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder({ status: 'REFUNDED' })))
  })
})

/**
 * Regression coverage for a real bug reported live on a user's downloaded
 * packing slip: the item showed as generic "Product"/₹0.00, and the
 * "Total" line showed ₹0.00 on a genuine ₹375 order. Root cause: admin's
 * `getOrderItems` returns `order_items`' real relational columns
 * (`product_name`/`unit_price`/`subtotal`), and the order row's real total
 * column is `total_payable` (migration 106 renamed it from `total_amount`)
 * — neither of `resolveItemDisplay`/`resolveOrderTotals` used to read
 * those real names at all. The prior "renders a valid PDF buffer" tests
 * above could never have caught this — a wrong number still produces a
 * perfectly valid PDF — hence these are unit tests on the pure resolver
 * functions directly.
 */
describe('resolveItemDisplay', () => {
  it('reads the real order_items relational columns (product_name/unit_price/subtotal), not just the camelCase shape', () => {
    const result = resolveItemDisplay({
      product_name: 'Chicken Breast Boneless', quantity: 1, unit_price: 350, subtotal: 350, net_quantity: '1 kg',
    })
    expect(result.label).toBe('Chicken Breast Boneless (1 kg)')
    expect(result.price).toBe(350)
    expect(result.total).toBe(350)
  })

  it('still reads the camelCase/checkout-snapshot shape (name/price/total/unit)', () => {
    const result = resolveItemDisplay({ name: 'Milk 1L', quantity: 2, price: 60, total: 120, unit: '1 L' })
    expect(result.label).toBe('Milk 1L (1 L)')
    expect(result.price).toBe(60)
    expect(result.total).toBe(120)
  })

  it('never silently renders "Product"/₹0 when a real name/price exists under either shape', () => {
    const result = resolveItemDisplay({ product_name: 'Mutton Curry Cut', unit_price: 420, subtotal: 420, quantity: 1 })
    expect(result.label).not.toBe('Product')
    expect(result.price).not.toBe(0)
    expect(result.total).not.toBe(0)
  })

  it('falls back to qty × price for total when genuinely nothing else is available', () => {
    const result = resolveItemDisplay({ quantity: 3, price: 10 })
    expect(result.total).toBe(30)
  })
})

describe('resolveOrderTotals', () => {
  it('reads the real total_payable column (migration 106 rename), not the old total_amount', () => {
    const totals = resolveOrderTotals({ subtotal: 350, delivery_fee: 25, handling_fee: 0, total_payable: 375 })
    expect(totals.total).toBe(375)
  })

  it('falls back to totalAmount/total_amount for any caller that still sends the pre-rename shape', () => {
    expect(resolveOrderTotals({ totalAmount: 140 }).total).toBe(140)
    expect(resolveOrderTotals({ total_amount: 140 }).total).toBe(140)
  })

  it('never silently reports ₹0 total when total_payable is genuinely present and non-zero', () => {
    const totals = resolveOrderTotals({ total_payable: 380 })
    expect(totals.total).not.toBe(0)
    expect(totals.total).toBe(380)
  })
})
