/**
 * Centralized error codes & messages.
 *
 * - `ERRORS` (existing): human-readable messages keyed by canonical name.
 * - `ERROR_CODES`: stable string code constants returned in the API
 *   `{ success, message, code }` envelope (apiResponse.js).
 * - `HTTP_STATUS`: code → HTTP status mapping per design §16 catalog.
 *
 * Source of truth: design §16 (Error Codes Catalog) and §4.4
 * (Shop_Scope_Middleware) of the multi-vendor-system spec.
 *
 * Backward compatibility (design §17.2):
 *   `ERROR_CODES.SHOP_SCOPE_MISMATCH` is a legacy alias whose value is
 *   `'CROSS_SHOP_ACCESS_DENIED'` so older callers reading
 *   `ERROR_CODES.SHOP_SCOPE_MISMATCH` transparently emit the new code.
 *
 * @see Requirements R16.10, R16.11, R16.15, R17.5, R17.6, R17.7,
 *      R18.8, R18.13, R18.14, R18.15, R18.16, R19.6, R20.5, R22.13,
 *      R23.9, R23.16, R23.19, R23.25, R26.5, R26.8, R29.7, R29.8
 */

/**
 * Centralized error messages — use these keys throughout the app
 * Keeps error strings consistent and easy to localize
 */
export const ERRORS = {
  // Auth
  PHONE_REQUIRED: 'Phone number is required',
  INVALID_PHONE: 'Invalid phone number format',
  OTP_SEND_FAILED: 'Failed to send OTP. Please try again.',
  INVALID_OTP: 'Invalid OTP',
  OTP_EXPIRED: 'OTP expired or not found. Request a new one.',
  OTP_LOCKED: 'Too many failed attempts. Account temporarily locked.',
  UNAUTHORIZED: 'Unauthorized — authentication required',
  TOKEN_EXPIRED: 'Token has expired',
  INVALID_TOKEN: 'Invalid token',
  REFRESH_TOKEN_REQUIRED: 'Refresh token is required',
  INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token',

  // Authorization
  FORBIDDEN: 'Forbidden — insufficient permissions',

  // User
  USER_NOT_FOUND: 'User not found',
  USER_BLOCKED: 'Your account has been blocked. Contact support.',
  EMAIL_TAKEN: 'Email is already in use',

  // General
  NOT_FOUND: 'Resource not found',
  VALIDATION_ERROR: 'Validation error',
  INTERNAL_ERROR: 'Internal server error',
  RATE_LIMIT: 'Rate limit exceeded. Please try again later.',

  // Products
  PRODUCT_NOT_FOUND: 'Product not found',
  OUT_OF_STOCK: 'Product is out of stock',

  // Orders
  ORDER_NOT_FOUND: 'Order not found',
  CANNOT_CANCEL: 'Order cannot be cancelled at this stage',
  EMPTY_CART: 'Cart is empty',

  // Payments
  PAYMENT_FAILED: 'Payment verification failed',
  INVALID_SIGNATURE: 'Invalid payment signature',

  // Coupons
  INVALID_COUPON: 'Invalid or expired coupon code',
  COUPON_LIMIT: 'Coupon usage limit reached',
}

/**
 * Canonical error code constants (string enum) returned in the
 * `code` field of API responses. Per design §16, the value of
 * `SHOP_SCOPE_MISMATCH` is intentionally `'CROSS_SHOP_ACCESS_DENIED'`
 * so legacy reads of `ERROR_CODES.SHOP_SCOPE_MISMATCH` resolve to the
 * new canonical code (R17 AC#5).
 *
 * Object is frozen to prevent accidental mutation at runtime.
 */
export const ERROR_CODES = Object.freeze({
  // ── Auth / session ────────────────────────────────────────────────
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',         // R18.14
  SESSION_INVALID: 'SESSION_INVALID',                 // R19.6
  USER_INACTIVE: 'USER_INACTIVE',                     // R18.13
  NO_ACTIVE_SHOP_ASSIGNMENTS: 'NO_ACTIVE_SHOP_ASSIGNMENTS', // R18.15
  SHOP_NOT_ASSIGNED: 'SHOP_NOT_ASSIGNED',             // R18.7 / R18.16
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED', // R20.7

  // ── Validation ────────────────────────────────────────────────────
  VALIDATION_ERROR: 'VALIDATION_ERROR',               // R18.15, R29.8
  PERMISSION_INVALID: 'PERMISSION_INVALID',           // R16.17 (R16.15)

  // ── Shop scope / RBAC ─────────────────────────────────────────────
  SHOP_SCOPE_REQUIRED: 'SHOP_SCOPE_REQUIRED',         // R17.6
  INVALID_SHOP_ID: 'INVALID_SHOP_ID',
  PERMISSION_DENIED: 'PERMISSION_DENIED',             // R17.7
  CROSS_SHOP_ACCESS_DENIED: 'CROSS_SHOP_ACCESS_DENIED', // R17.5
  /**
   * Legacy alias preserved for backward compatibility (design §17.2).
   * Value is `'CROSS_SHOP_ACCESS_DENIED'` so callers reading
   * `ERROR_CODES.SHOP_SCOPE_MISMATCH` emit the new canonical code.
   */
  SHOP_SCOPE_MISMATCH: 'CROSS_SHOP_ACCESS_DENIED',
  SHOP_SCOPE_FORBIDDEN: 'SHOP_SCOPE_FORBIDDEN',       // R16.19
  STAFF_INACTIVE: 'STAFF_INACTIVE',
  STAFF_ROLE_FORBIDDEN: 'STAFF_ROLE_FORBIDDEN',       // R16.10, R16.11

  // ── Centralized RBAC Error Codes (Blueprint §05.1) ─────────────────
  RBAC_PERMISSION_DENIED: 'RBAC_PERMISSION_DENIED',
  RBAC_ROLE_NOT_FOUND: 'RBAC_ROLE_NOT_FOUND',
  RBAC_INVALID_PERMISSION: 'RBAC_INVALID_PERMISSION',
  RBAC_SCOPE_REQUIRED: 'RBAC_SCOPE_REQUIRED',
  RBAC_ROLE_DISABLED: 'RBAC_ROLE_DISABLED',

  // ── Rate limiting ─────────────────────────────────────────────────
  RATE_LIMITED: 'RATE_LIMITED',                       // R18.11

  // ── Conflicts (409) ───────────────────────────────────────────────
  EMAIL_TAKEN: 'EMAIL_TAKEN',                         // R20.5
  MASTER_PRODUCT_EXISTS: 'MASTER_PRODUCT_EXISTS',     // R23.16
  STOCK_NEGATIVE_FORBIDDEN: 'STOCK_NEGATIVE_FORBIDDEN', // R23.9
  ORDER_STATE_INVALID: 'ORDER_STATE_INVALID',         // R22.13

  // ── Products ──────────────────────────────────────────────────────
  PRODUCT_IMAGE_INVALID: 'PRODUCT_IMAGE_INVALID',     // R23.19
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',

  // ── Coupons (R26) ────────────────────────────────────────────────
  COUPON_NOT_FOUND: 'COUPON_NOT_FOUND',               // R26.8
  COUPON_INACTIVE: 'COUPON_INACTIVE',                 // R26.8
  COUPON_EXPIRED: 'COUPON_EXPIRED',                   // R26.8
  COUPON_NOT_STARTED: 'COUPON_NOT_STARTED',           // R26.8
  COUPON_MIN_ORDER_NOT_MET: 'COUPON_MIN_ORDER_NOT_MET', // R26.8
  COUPON_LIMIT_REACHED: 'COUPON_LIMIT_REACHED',       // R26.8
  COUPON_USER_LIMIT_REACHED: 'COUPON_USER_LIMIT_REACHED', // R26.8
  COUPON_NOT_APPLICABLE: 'COUPON_NOT_APPLICABLE',     // R26.8
  COUPON_SCOPE_FORBIDDEN: 'COUPON_SCOPE_FORBIDDEN',   // R26.5
  COUPON_SEGMENT_RESTRICTED: 'COUPON_SEGMENT_RESTRICTED', // customer-segment targeting

  // ── Purchase limits (admin-configured category/product order caps) ─
  PURCHASE_LIMIT_ORDER_EXCEEDED: 'PURCHASE_LIMIT_ORDER_EXCEEDED',
  PURCHASE_LIMIT_WINDOW_EXCEEDED: 'PURCHASE_LIMIT_WINDOW_EXCEEDED',

  // ── Misc ─────────────────────────────────────────────────────────
  MISSING_ORDER_ID: 'MISSING_ORDER_ID',
  FEATURE_DISABLED: 'FEATURE_DISABLED',                 // R23.10 (gate)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

/**
 * HTTP status mapping per design §16. Lookup by canonical code
 * (or by the alias key — both resolve to the same status because
 * the alias's value equals the canonical code).
 *
 * Defaults to 500 (`INTERNAL_ERROR`) for unknown codes.
 */
export const HTTP_STATUS = Object.freeze({
  // 400 — Bad Request
  [ERROR_CODES.VALIDATION_ERROR]: 400,
  [ERROR_CODES.SHOP_SCOPE_REQUIRED]: 400,
  [ERROR_CODES.INVALID_SHOP_ID]: 400,
  [ERROR_CODES.MISSING_ORDER_ID]: 400,
  [ERROR_CODES.PERMISSION_INVALID]: 400,
  [ERROR_CODES.RBAC_INVALID_PERMISSION]: 400,
  [ERROR_CODES.RBAC_SCOPE_REQUIRED]: 400,
  [ERROR_CODES.PRODUCT_IMAGE_INVALID]: 400,
  [ERROR_CODES.COUPON_NOT_FOUND]: 400,
  [ERROR_CODES.COUPON_INACTIVE]: 400,
  [ERROR_CODES.COUPON_EXPIRED]: 400,
  [ERROR_CODES.COUPON_NOT_STARTED]: 400,
  [ERROR_CODES.COUPON_MIN_ORDER_NOT_MET]: 400,
  [ERROR_CODES.COUPON_LIMIT_REACHED]: 400,
  [ERROR_CODES.COUPON_USER_LIMIT_REACHED]: 400,
  [ERROR_CODES.COUPON_NOT_APPLICABLE]: 400,
  [ERROR_CODES.COUPON_SEGMENT_RESTRICTED]: 400,
  [ERROR_CODES.PURCHASE_LIMIT_ORDER_EXCEEDED]: 400,
  [ERROR_CODES.PURCHASE_LIMIT_WINDOW_EXCEEDED]: 400,

  // 401 — Unauthorized
  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.INVALID_CREDENTIALS]: 401,
  [ERROR_CODES.SESSION_INVALID]: 401,

  // 403 — Forbidden
  [ERROR_CODES.PERMISSION_DENIED]: 403,
  [ERROR_CODES.CROSS_SHOP_ACCESS_DENIED]: 403,
  // SHOP_SCOPE_MISMATCH alias resolves to CROSS_SHOP_ACCESS_DENIED (same key)
  [ERROR_CODES.SHOP_SCOPE_FORBIDDEN]: 403,
  [ERROR_CODES.STAFF_INACTIVE]: 403,
  [ERROR_CODES.STAFF_ROLE_FORBIDDEN]: 403,
  [ERROR_CODES.USER_INACTIVE]: 403,
  [ERROR_CODES.NO_ACTIVE_SHOP_ASSIGNMENTS]: 403,
  [ERROR_CODES.SHOP_NOT_ASSIGNED]: 403,
  [ERROR_CODES.PASSWORD_CHANGE_REQUIRED]: 403,
  [ERROR_CODES.COUPON_SCOPE_FORBIDDEN]: 403,

  // 404 — Not Found
  [ERROR_CODES.PRODUCT_NOT_FOUND]: 404,

  // 409 — Conflict
  [ERROR_CODES.EMAIL_TAKEN]: 409,
  [ERROR_CODES.MASTER_PRODUCT_EXISTS]: 409,
  [ERROR_CODES.STOCK_NEGATIVE_FORBIDDEN]: 409,
  [ERROR_CODES.ORDER_STATE_INVALID]: 409,

  // 429 — Too Many Requests
  [ERROR_CODES.RATE_LIMITED]: 429,

  // 503 — Service Unavailable
  [ERROR_CODES.FEATURE_DISABLED]: 503,

  // 500 — Internal Server Error
  [ERROR_CODES.INTERNAL_ERROR]: 500,
})

/**
 * Returns the HTTP status for a given error code, defaulting to 500.
 * @param {string} code one of `ERROR_CODES`
 * @returns {number} HTTP status (400, 401, 403, 404, 409, 429, 500)
 */
export function httpStatusFor(code) {
  return HTTP_STATUS[code] ?? 500
}
