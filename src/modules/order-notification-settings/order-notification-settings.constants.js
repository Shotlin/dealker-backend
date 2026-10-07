// The canonical set of order-lifecycle event keys — must stay in sync with
// customer-order-event.helper.js's own messageMap keys (that file is the
// hardcoded-default source of truth; this table is the admin-editable
// override on top of it). Both admin CRUD validation and the public
// event-flags endpoint iterate this list, so it's the one place a future
// new lifecycle stage needs to be added.
export const ORDER_NOTIFICATION_EVENT_KEYS = [
  'ORDER_PLACED',
  'CONFIRMED',
  'PREPARING',
  'PACKED',
  'RIDER_ACCEPTED',
  'PICKED_UP',
  'OTP_RESENT',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
]

export const ORDER_NOTIFICATION_EVENT_KEY_SET = new Set(ORDER_NOTIFICATION_EVENT_KEYS)

/** Short, non-technical description shown next to each event in the dashboard list. */
export const ORDER_NOTIFICATION_EVENT_LABELS = {
  ORDER_PLACED: 'Order placed and sent for confirmation',
  CONFIRMED: 'Store confirms the order',
  PREPARING: 'Store starts preparing the order',
  PACKED: 'Order packed and ready for pickup',
  RIDER_ACCEPTED: 'A delivery partner accepts the order',
  PICKED_UP: 'Delivery partner picks up and departs',
  OTP_RESENT: 'Customer requests their delivery OTP again',
  DELIVERED: 'Order delivered to the customer',
  CANCELLED: 'Order cancelled',
  REFUNDED: 'Refund processed for the order',
}

/**
 * Replaces the two real placeholders every event's `data` can supply —
 * {{orderId}} (really the customer-facing order NUMBER, kept as "orderId"
 * since that's the name shown in the dashboard's placeholder chips) and
 * {{otp}} (only meaningfully present for OTP_RESENT; PICKED_UP's own OTP
 * suffix is handled separately, see notifications.service.js, so a delivery
 * OTP is never exposed as freely-editable admin text). Unmatched
 * placeholders are left as literal text rather than silently blanked, so a
 * typo'd token is visibly wrong instead of invisibly disappearing.
 */
export function interpolateOrderNotificationTemplate(template, data = {}) {
  if (!template) return template
  return template
    .replace(/\{\{\s*orderId\s*\}\}/g, data.orderNumber ?? data.orderId ?? '')
    .replace(/\{\{\s*otp\s*\}\}/g, data.deliveryOtp ?? data.otp ?? '')
}
