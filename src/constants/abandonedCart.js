// Fixed backend constant (not admin-adjustable via dashboard) per product
// decision — a value like this changes rarely enough that a redeploy is an
// acceptable cost, and it avoids a whole extra settings table/UI for it.
export const ABANDONMENT_THRESHOLD_MS = 1 * 60 * 1000 // 1 minute

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
