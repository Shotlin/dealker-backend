// Feature: multi-vendor-system, Pure financial formulas (Property 8)
// **Validates: Requirements 6.3, 6.4**
//
// Pure, side-effect-free helpers for the Shop_Financial formulas defined
// in design.md and Requirements 6.3 / 6.4. Exposed as their own module so
// that:
//
//   • The Settlement_Worker (task 9.1) can import these directly when it
//     aggregates daily orders into shop_financials rows.
//   • Property 8 (`tests/property/financial-formula.property.test.js`)
//     can drive the same code paths fast-check style.
//   • Unit tests can verify the formulas without a database or Redis.
//
// All arithmetic is performed in integer cents (×100) and rounded with
// half-away-from-zero `Math.round` to keep results cent-precise
// (DECIMAL(*,2) in the schema) and avoid IEEE-754 drift like
// `0.1 + 0.2 = 0.30000000000004`.
//
// No I/O, no DB, no Redis — these helpers are O(1) arithmetic and safe to
// call from any layer (service, worker, test) on the 2-core / 4GB target.

/**
 * Coerce DECIMAL strings (pg returns numerics as strings) and miscellaneous
 * non-numeric input into a finite Number, defaulting to 0.
 *
 * @param {unknown} v
 * @returns {number}
 */
function toFiniteNumber(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Convert a money-shaped Number (e.g. 12.34) to integer cents (1234) using
 * half-away-from-zero rounding at 2dp. Negative values round symmetrically
 * (`-12.345 → -1235`) so cent arithmetic round-trips through both signs.
 *
 * @param {number|string} v
 * @returns {number}
 */
function toCents(v) {
  const n = toFiniteNumber(v)
  return n >= 0 ? Math.round(n * 100) : -Math.round(-n * 100)
}

/**
 * Money-precise round to 2 decimal places.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0
  return n >= 0 ? Math.round(n * 100) / 100 : -Math.round(-n * 100) / 100
}

/**
 * Requirement 6.3 — platform_commission is the Shop's commission_rate
 * percentage of gross_revenue, rounded to two decimals to fit DECIMAL(10,2).
 *
 *   commission = round2(gross_revenue * commission_rate / 100)
 *
 * Computed in integer cents so the result is exact for cent-precise inputs.
 *
 * @param {number|string} grossRevenue   gross revenue, ≥ 0
 * @param {number|string} commissionRate commission rate, percent (0..100)
 * @returns {number} commission rounded to 2dp
 */
export function computeCommission(grossRevenue, commissionRate) {
  const grossCents = toCents(grossRevenue)
  // commission_rate is DECIMAL(5,2) — keep two decimal places of precision.
  const rateBps = toCents(commissionRate)
  // gross_cents * rate_bps is in units of (cents · 1/10_000),
  // i.e. dividing by 10_000 returns cents.
  const commissionCents = Math.round((grossCents * rateBps) / 10_000)
  return commissionCents / 100
}

/**
 * Requirement 6.4 — net_revenue is gross minus commission, delivery, refunds:
 *
 *   net = gross - commission - delivery - refunds
 *
 * `commissionRate` is taken (not a pre-computed commission) so callers always
 * agree with `computeCommission` and Property 8's intermediate value. The
 * function does NOT clamp to zero — net may legitimately be negative when
 * refunds + delivery exceed gross − commission, and the ledger requires the
 * true mathematical value.
 *
 * @param {object} input
 * @param {number|string} input.grossRevenue
 * @param {number|string} input.commissionRate
 * @param {number|string} input.deliveryCosts
 * @param {number|string} input.refundAmount
 * @returns {number} net rounded to 2dp (may be negative)
 */
export function computeNetRevenue({
  grossRevenue,
  commissionRate,
  deliveryCosts,
  refundAmount,
} = {}) {
  const grossCents = toCents(grossRevenue)
  const deliveryCents = toCents(deliveryCosts)
  const refundCents = toCents(refundAmount)
  const commissionCents = Math.round(
    computeCommission(grossRevenue, commissionRate) * 100
  )
  const netCents = grossCents - commissionCents - deliveryCents - refundCents
  return netCents / 100
}

/**
 * avg_order_value = gross_revenue / total_orders, rounded to 2dp.
 * Returns 0 when total_orders is 0 (matches DECIMAL(10,2) DEFAULT 0 in the
 * shop_financials schema and avoids divide-by-zero).
 *
 * @param {number|string} grossRevenue
 * @param {number|string} totalOrders
 * @returns {number}
 */
export function computeAvgOrderValue(grossRevenue, totalOrders) {
  const n = Math.max(0, Math.trunc(toFiniteNumber(totalOrders)))
  if (n === 0) return 0
  const g = toFiniteNumber(grossRevenue)
  return round2(g / n)
}
