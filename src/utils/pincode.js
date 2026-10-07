/**
 * Indian PIN-code normalisation — the single definition every serviceability
 * code path shares (shop service-area writes, address validation, storefront
 * location resolution, allocation matching).
 *
 * Serviceability compares PINs by exact string equality
 * (`$1 = ANY(shops.serviceable_pincodes)`), so a stray space, a duplicate, or
 * a non-string value on either side silently turns "PIN is configured" into
 * "not serviceable". Normalising at every boundary keeps both sides identical.
 */

/** A valid Indian PIN: 6 digits, first digit 1-9 (same rule as addresses.schema.js). */
export const PINCODE_REGEX = /^[1-9][0-9]{5}$/

/**
 * Trim and remove ALL whitespace (`"700 016"` → `"700016"`, `" 201301\n"` →
 * `"201301"`). Non-string input is stringified; null/undefined → `''`.
 * Does NOT validate — see {@link isValidPincode}.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cleanPincode(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/g, '')
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPincode(value) {
  return typeof value === 'string' && PINCODE_REGEX.test(value)
}

/**
 * Clean a list of PINs for storage: trim/strip whitespace, drop blanks, and
 * de-duplicate while preserving first-seen order. Malformed entries are KEPT
 * (so callers can report them) — use {@link isValidPincode} to validate.
 *
 * @param {unknown} values
 * @returns {string[]}
 */
export function cleanPincodeList(values) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const out = []
  for (const raw of values) {
    const pin = cleanPincode(raw)
    if (!pin || seen.has(pin)) continue
    seen.add(pin)
    out.push(pin)
  }
  return out
}
