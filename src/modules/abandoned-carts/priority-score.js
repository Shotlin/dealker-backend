// Smart Recovery Priority Score — a pure function so it's trivially unit
// testable without a database. Computed ONCE at first detection only (the
// worker never recomputes it on a resweep), so the admin-facing ranking
// stays stable while a row is being viewed.
//
// Weights sum to 1.0:
//   cart value        35% — bigger baskets are worth chasing first
//   product count      15% — more distinct items = more considered purchase
//   customer LTV       25% — proven spenders are the highest-confidence recovery target
//   recency             15% — a cart abandoned 5 min ago is warmer than one from yesterday
//   past recovery rate  10% — has this specific customer responded to nudges before?

const WEIGHTS = {
  cartValue: 0.35,
  itemCount: 0.15,
  ltv: 0.25,
  recency: 0.15,
  recoveryRate: 0.1,
}

// Normalization ceilings — cart value / LTV / item count scores saturate
// at 1.0 past these thresholds rather than growing unbounded, so one
// outlier order doesn't blow the scale for everyone else.
const CART_VALUE_CEILING = 2000
const ITEM_COUNT_CEILING = 8
const LTV_CEILING = 10000
const RECENCY_HALF_LIFE_MINUTES = 1440 // 24h — recency score decays to 0 by this point

/**
 * @param {object} input
 * @param {number} input.cartValue
 * @param {number} input.itemCount
 * @param {number} input.ltv - customer's lifetime value (delivered orders total)
 * @param {number} input.minutesSinceAbandonment
 * @param {number|null} input.recoveryRate - 0..1, or null if the user has no closed episodes yet
 * @returns {{score: number, breakdown: object}}
 */
export function computeRecoveryPriorityScore({
  cartValue,
  itemCount,
  ltv,
  minutesSinceAbandonment,
  recoveryRate,
}) {
  const cartValueScore = clamp01(cartValue / CART_VALUE_CEILING)
  const itemCountScore = clamp01(itemCount / ITEM_COUNT_CEILING)
  const ltvScore = clamp01(ltv / LTV_CEILING)
  const recencyScore = clamp01(1 - minutesSinceAbandonment / RECENCY_HALF_LIFE_MINUTES)
  // No prior closed episodes → neutral 0.5 rather than penalizing a
  // first-time abandoner for having no track record either way.
  const recoveryRateScore = recoveryRate === null || recoveryRate === undefined
    ? 0.5
    : clamp01(recoveryRate)

  const contributions = {
    cartValue: WEIGHTS.cartValue * cartValueScore,
    itemCount: WEIGHTS.itemCount * itemCountScore,
    ltv: WEIGHTS.ltv * ltvScore,
    recency: WEIGHTS.recency * recencyScore,
    recoveryRate: WEIGHTS.recoveryRate * recoveryRateScore,
  }

  const total = Object.values(contributions).reduce((sum, v) => sum + v, 0)
  const score = round2(100 * total)

  return {
    score,
    breakdown: {
      cartValue: { raw: cartValue, normalized: round2(cartValueScore), weight: WEIGHTS.cartValue, contribution: round2(100 * contributions.cartValue) },
      itemCount: { raw: itemCount, normalized: round2(itemCountScore), weight: WEIGHTS.itemCount, contribution: round2(100 * contributions.itemCount) },
      ltv: { raw: ltv, normalized: round2(ltvScore), weight: WEIGHTS.ltv, contribution: round2(100 * contributions.ltv) },
      recency: { raw: minutesSinceAbandonment, normalized: round2(recencyScore), weight: WEIGHTS.recency, contribution: round2(100 * contributions.recency) },
      recoveryRate: { raw: recoveryRate, normalized: round2(recoveryRateScore), weight: WEIGHTS.recoveryRate, contribution: round2(100 * contributions.recoveryRate) },
    },
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function round2(n) {
  return Math.round(n * 100) / 100
}
