/**
 * Geo-distance helpers (haversine).
 *
 * Mirrors the SQL haversine used in allocation.repository.js (Earth radius
 * 6371 km, acos clamped to ±1) so distance-based delivery fees agree with the
 * shop-allocation distances already stored on user_shop_allocations.
 */

const EARTH_RADIUS_KM = 6371

function toRadians(deg) {
  return (deg * Math.PI) / 180
}

/**
 * Great-circle distance between two lat/lng points in kilometres.
 * Returns null when any coordinate is missing or non-finite.
 *
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number|null} distance in km (>= 0) or null when uncomputable
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const a = Number(lat1)
  const b = Number(lng1)
  const c = Number(lat2)
  const d = Number(lng2)
  if (![a, b, c, d].every((v) => Number.isFinite(v))) return null

  const dLat = toRadians(c - a)
  const dLng = toRadians(d - b)
  const lat1Rad = toRadians(a)
  const lat2Rad = toRadians(c)

  const sinDLat = Math.sin(dLat / 2)
  const sinDLng = Math.sin(dLng / 2)
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLng * sinDLng

  // Clamp to guard against floating-point drift pushing acos out of domain.
  const clamped = Math.min(1, Math.max(0, h))
  const central = 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped))
  const km = EARTH_RADIUS_KM * central
  return Number.isFinite(km) ? km : null
}

/**
 * Format a distance for display. Returns "" when distance is null.
 * @param {number|null} km
 * @returns {string} e.g. "2.8 km"
 */
export function formatDistanceKm(km) {
  if (km === null || km === undefined || !Number.isFinite(Number(km))) return ''
  return `${Number(km).toFixed(1)} km`
}

export { EARTH_RADIUS_KM }
