/**
 * In-process cache of "every PIN any active shop serves", used by
 * `POST /addresses/validate-pincode` (addresses.service.js).
 *
 * Kept in its own dependency-free module so the shops service can invalidate
 * it when a shop's service area changes WITHOUT importing the addresses
 * service (which pulls in the database, allocation and fee modules).
 *
 * Only a non-empty `Set<string>` of serviceable PINs is ever stored; the
 * "no shop has PINs / lookup failed → allow all" result is never cached, so
 * `undefined` (nothing cached or expired) tells the caller to reload.
 */

export const SERVICEABLE_PINCODE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

let cachedValue
let cachedAt = 0

/**
 * @param {number} [now]
 * @returns {Set<string>|undefined}
 */
export function getCachedServiceablePincodes(now = Date.now()) {
  if (cachedValue === undefined) return undefined
  if (now - cachedAt >= SERVICEABLE_PINCODE_CACHE_TTL_MS) return undefined
  return cachedValue
}

/**
 * @param {Set<string>} value
 * @param {number} [now]
 */
export function setCachedServiceablePincodes(value, now = Date.now()) {
  cachedValue = value
  cachedAt = now
}

/**
 * Drop the cached PIN set. Call after any change to a shop's
 * `serviceable_pincodes`, `is_active` or `deleted_at` so validate-pincode
 * reflects the dashboard immediately instead of after the TTL.
 */
export function invalidateServiceablePincodeCache() {
  cachedValue = undefined
  cachedAt = 0
}
