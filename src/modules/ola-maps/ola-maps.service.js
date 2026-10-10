import { query } from '../../config/database.js'
import { encryptSecret, decryptSecret } from '../../utils/encryption.js'

/**
 * Ola Maps (https://maps.olakrutrim.com) — key lives in `ola_maps_settings` (migration 115, one row),
 * pasted from the dashboard and stored encrypted. The mobile app never sees the key: it calls the
 * `/maps/ola/*` proxy below (only `style-url` returns a URL that carries the key, because MapLibre
 * needs one to fetch tiles).
 */
const BASE = 'https://api.olamaps.io'
const STYLE = 'default-light-standard'
const TIMEOUT_MS = 8000

let cache = { at: 0, row: null }

async function loadRow() {
  if (Date.now() - cache.at < 30_000) return cache.row
  const { rows } = await query('SELECT * FROM ola_maps_settings LIMIT 1')
  cache = { at: Date.now(), row: rows[0] || null }
  return cache.row
}

const clearCache = () => { cache = { at: 0, row: null } }

const mask = (k) => (k ? `${'•'.repeat(8)}${k.slice(-4)}` : null)

function adminView(row) {
  const key = row?.api_key ? decryptSecret(row.api_key) : null
  return {
    configured: !!key,
    isEnabled: !!row?.is_enabled,
    maskedKey: mask(key),
    lastTestedAt: row?.last_tested_at?.toISOString?.() ?? null,
    lastTestStatus: row?.last_test_status ?? null,
    lastTestMessage: row?.last_test_message ?? null,
    updatedAt: row?.updated_at?.toISOString?.() ?? null,
  }
}

async function call(path, params, key, init = {}) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  url.searchParams.set('api_key', key)
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'X-Request-Id': crypto.randomUUID(), ...(init.headers || {}) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text }
}

/** Live check of a key with a tiny reverse-geocode (New Delhi). */
export async function testKey(key) {
  try {
    const r = await call('/places/v1/reverse-geocode', { latlng: '28.6139,77.2090' }, key)
    if (r.ok) return { success: true, statusCode: r.status, message: 'Connection successful' }
    return { success: false, statusCode: r.status, message: r.status === 401 || r.status === 403 ? 'Ola Maps rejected this API key' : `Ola Maps returned ${r.status}` }
  } catch (err) {
    return { success: false, statusCode: null, message: `Could not reach Ola Maps (${err.name === 'TimeoutError' ? 'timed out' : err.message})` }
  }
}

export async function getAdminSettings() {
  cache = { at: 0, row: null }
  return adminView(await loadRow())
}

export async function saveSettings({ apiKey, isEnabled }, userId) {
  const row = await loadRow()
  let enc = row?.api_key ?? null
  let test = null
  let enable = typeof isEnabled === 'boolean' ? isEnabled : !!row?.is_enabled
  if (apiKey !== undefined) {
    const k = String(apiKey).trim()
    if (!k) { enc = null; enable = false } else {
      test = await testKey(k)
      enc = encryptSecret(k)
      // A key that fails the live test is stored but never switched on.
      if (!test.success) enable = false
    }
  }
  const { rows } = await query(
    `UPDATE ola_maps_settings SET api_key = $1, is_enabled = $2,
            last_tested_at = COALESCE($3, last_tested_at), last_test_status = COALESCE($4, last_test_status),
            last_test_message = COALESCE($5, last_test_message), updated_by = $6, updated_at = NOW() RETURNING *`,
    [enc, enable && !!enc, test ? new Date() : null, test ? (test.success ? 'SUCCESS' : 'FAILED') : null, test?.message ?? null, userId || null]
  )
  clearCache()
  return { settings: adminView(rows[0]), test }
}

/** The decrypted key when Ola is configured AND enabled, else null. */
async function activeKey() {
  const row = await loadRow()
  if (!row?.is_enabled || !row.api_key) return null
  try { return decryptSecret(row.api_key) } catch { return null }
}

export class OlaNotConfigured extends Error {}

export async function styleUrl() {
  const key = await activeKey()
  if (!key) return { configured: false, styleUrl: null }
  return { configured: true, styleUrl: `${BASE}/tiles/vector/v1/styles/${STYLE}/style.json?api_key=${encodeURIComponent(key)}` }
}

async function proxy(path, params, init) {
  const key = await activeKey()
  if (!key) throw new OlaNotConfigured('Ola Maps is not configured')
  const r = await call(path, params, key, init)
  if (!r.ok) {
    const e = new Error(`Ola Maps returned ${r.status}`)
    e.statusCode = r.status === 429 ? 429 : 502
    throw e
  }
  return r.json
}

export const geocode = (address) => proxy('/places/v1/geocode', { address })
export const reverseGeocode = (lat, lng) => proxy('/places/v1/reverse-geocode', { latlng: `${lat},${lng}` })

/** Straight pass of Ola's directions, reduced to what the app needs: decoded points, metres, seconds. */
export async function directions(o, d) {
  const json = await proxy('/routing/v1/directions', { origin: `${o.lat},${o.lng}`, destination: `${d.lat},${d.lng}` }, { method: 'POST' })
  const route = json?.routes?.[0]
  const leg = route?.legs?.[0]
  if (!route || !leg) return { points: [], distanceMeters: null, durationSeconds: null }
  return { points: decodePolyline(route.overview_polyline), distanceMeters: Math.round(Number(leg.distance ?? leg.distance?.value)), durationSeconds: Math.round(Number(leg.duration ?? leg.duration?.value)) }
}

function decodePolyline(enc) {
  if (typeof enc !== 'string') return []
  const pts = []
  let i = 0, lat = 0, lng = 0
  while (i < enc.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b
      do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (axis === 0) lat += delta; else lng += delta
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return pts
}
