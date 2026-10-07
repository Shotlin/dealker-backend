// How long a cart must sit untouched before it counts as abandoned.
// Default 30 min; override per environment with ABANDONED_CART_THRESHOLD_MINUTES
// (e.g. 2 on a demo/test server so the flow can be watched live).
const thresholdMinutes = Number(process.env.ABANDONED_CART_THRESHOLD_MINUTES)
export const ABANDONMENT_THRESHOLD_MS =
  (Number.isFinite(thresholdMinutes) && thresholdMinutes > 0 ? thresholdMinutes : 30) * 60 * 1000

// Per-sweep cap on how many inactive users the worker processes in one
// 60s tick — keeps each run bounded even if a backlog builds up; the
// ascending-score ZRANGEBYSCORE query means the longest-idle carts are
// always drained first across successive ticks.
export const ABANDONED_CART_SWEEP_BATCH_LIMIT = 50

// An OPEN episode that's never recovered/converted auto-closes as EXPIRED
// after this long — matches the Redis cart's own TTL (CART_TTL in
// cart.repository.js), since the underlying cart would already be gone.
export const ABANDONED_CART_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export const ABANDONED_CART_STATUS = {
  OPEN: 'OPEN',
  RECOVERED: 'RECOVERED',
  CONVERTED: 'CONVERTED',
  EXPIRED: 'EXPIRED',
}

export const ABANDONED_CART_EVENT_TYPE = {
  DETECTED: 'DETECTED',
  RESWEPT: 'RESWEPT',
  RECOVERED: 'RECOVERED',
  CONVERTED: 'CONVERTED',
  EXPIRED: 'EXPIRED',
  REMINDER_SENT: 'REMINDER_SENT',
  COUPON_ISSUED: 'COUPON_ISSUED',
}

// Minimum gap between two reminders to the SAME abandoned cart, so a
// customer is never spammed by repeated admin clicks or bulk sends.
const cooldownMinutes = Number(process.env.ABANDONED_CART_REMINDER_COOLDOWN_MINUTES)
export const ABANDONED_CART_REMINDER_COOLDOWN_MS =
  (Number.isFinite(cooldownMinutes) && cooldownMinutes >= 0 ? cooldownMinutes : 60) * 60 * 1000

export const ABANDONED_CART_BULK_LIMIT = 100

// One-click "quick coupon" presets. Each becomes a real coupon in the
// existing coupon engine, individually targeted to the one customer, single
// use, expiring after `validHours`.
export const QUICK_COUPON_PRESETS = {
  PERCENT_5: { label: '5% off', discountType: 'PERCENTAGE', discountValue: 5, maxDiscount: 150, minOrderAmount: 0 },
  PERCENT_10: { label: '10% off', discountType: 'PERCENTAGE', discountValue: 10, maxDiscount: 300, minOrderAmount: 499 },
  PERCENT_15: { label: '15% off', discountType: 'PERCENTAGE', discountValue: 15, maxDiscount: 500, minOrderAmount: 999 },
  FLAT_50: { label: '₹50 off', discountType: 'FLAT', discountValue: 50, minOrderAmount: 299 },
  FLAT_100: { label: '₹100 off', discountType: 'FLAT', discountValue: 100, minOrderAmount: 699 },
  FREE_DELIVERY: { label: 'Free delivery', discountType: 'FREE_DELIVERY', discountValue: 0, minOrderAmount: 0 },
}
export const QUICK_COUPON_DEFAULT_VALID_HOURS = 48
export const QUICK_COUPON_MAX_VALID_HOURS = 24 * 30
