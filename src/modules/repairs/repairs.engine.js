/**
 * Repair engine — pure rules, no I/O.
 *
 *   REQUESTED → ACCEPTED → INSPECTION → ESTIMATE_SENT → ESTIMATE_APPROVED → IN_REPAIR → QC_PENDING
 *            → REPAIRED → READY_FOR_DELIVERY → COMPLETED
 *   Side exits: REJECTED, CANCELLED (before the device arrives), ESTIMATE_REJECTED and FAILED (device is returned
 *   through READY_FOR_DELIVERY), QC_PENDING → IN_REPAIR (rework), COMPLETED → IN_REPAIR (warranty reopen).
 *
 * Money is computed in integer paise so totals never drift.
 */

export const STATUSES = [
  'REQUESTED', 'ACCEPTED', 'INSPECTION', 'ESTIMATE_SENT', 'ESTIMATE_APPROVED', 'IN_REPAIR', 'QC_PENDING',
  'REPAIRED', 'READY_FOR_DELIVERY', 'COMPLETED', 'REJECTED', 'CANCELLED', 'ESTIMATE_REJECTED', 'FAILED',
]

export const TRANSITIONS = Object.freeze({
  REQUESTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['INSPECTION', 'CANCELLED'],
  INSPECTION: ['ESTIMATE_SENT', 'FAILED'],
  ESTIMATE_SENT: ['ESTIMATE_APPROVED', 'ESTIMATE_REJECTED'],
  ESTIMATE_APPROVED: ['IN_REPAIR', 'ESTIMATE_REJECTED'],
  IN_REPAIR: ['QC_PENDING', 'FAILED'],
  QC_PENDING: ['REPAIRED', 'IN_REPAIR'],
  REPAIRED: ['READY_FOR_DELIVERY'],
  ESTIMATE_REJECTED: ['READY_FOR_DELIVERY'],
  FAILED: ['READY_FOR_DELIVERY'],
  READY_FOR_DELIVERY: ['COMPLETED'],
  COMPLETED: ['IN_REPAIR'],         // warranty reopen only (checked against warranty_until)
  REJECTED: [],
  CANCELLED: [],
})

export const TERMINAL = ['REJECTED', 'CANCELLED']

/** Queues shown on the dashboard. */
export const TABS = Object.freeze({
  new: ['REQUESTED'],
  intake: ['ACCEPTED', 'INSPECTION'],
  approval: ['ESTIMATE_SENT'],
  progress: ['ESTIMATE_APPROVED', 'IN_REPAIR'],
  qc: ['QC_PENDING'],
  ready: ['REPAIRED', 'READY_FOR_DELIVERY'],
  problem: ['FAILED', 'ESTIMATE_REJECTED'],
  completed: ['COMPLETED'],
  closed: ['REJECTED', 'CANCELLED'],
})

export const canMove = (from, to) => !!TRANSITIONS[from]?.includes(to)

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export const LINE_KINDS = ['LABOUR', 'PART', 'DIAGNOSTIC', 'OTHER']

const paise = (rupees) => Math.round(Number(rupees) * 100)
const rupees = (p) => Math.round(p) / 100

/**
 * Quote maths. Lines are validated by the caller; this only computes.
 * discount applies to the subtotal, tax to the discounted amount (tax-exclusive prices).
 */
export function computeQuote({ lines, discountPct = 0, taxPct = 0 }) {
  let sub = 0
  const out = lines.map((l) => {
    const amount = Math.round(l.qty * paise(l.unitPrice))
    sub += amount
    return { ...l, amount: rupees(amount) }
  })
  const discount = Math.round((sub * discountPct) / 100)
  const taxable = sub - discount
  const tax = Math.round((taxable * taxPct) / 100)
  return {
    lines: out,
    subtotal: rupees(sub),
    discountPct,
    discountAmount: rupees(discount),
    taxable: rupees(taxable),
    taxPct,
    taxAmount: rupees(tax),
    total: rupees(taxable + tax),
  }
}

/** Advance to collect before work starts. */
export const advanceFor = (total, pct) => rupees(Math.round((paise(total) * pct) / 100))

/** Split the platform's commission off the pre-tax amount of a finished repair. */
export function settle({ taxable, commissionPct }) {
  const t = paise(taxable)
  const commission = Math.round((t * commissionPct) / 100)
  return { commission: rupees(commission), vendorPayable: rupees(t - commission) }
}

export const warrantyUntil = (from, days) => {
  const d = new Date(from)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const money = { paise, rupees }
