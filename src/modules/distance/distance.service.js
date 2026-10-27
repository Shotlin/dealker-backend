/**
 * Road distance from a customer's pinned location to vendor shops, saved so the map API is called at most
 * once per (origin, shop) pair:
 *   1. look the pair up in address_shop_distances (ROAD is permanent while the shop pin is unchanged);
 *   2. misses are fetched from Ola Maps directions (4 at a time, 3.5 s each, de-duplicated while in flight)
 *      and stored;
 *   3. if Ola is off / slow / failing we answer with straight-line x 1.3 (method EST), store it for 6 hours
 *      and try the real road distance again later. A short circuit-breaker stops hammering a failing API.
 */
import { query } from '../../config/database.js'
import { haversineKm } from '../../utils/distance.js'
import { directions } from '../ola-maps/ola-maps.service.js'

const EST_FACTOR = 1.3
const EST_TTL_MS = 6 * 3600 * 1000
const MAX_ROAD_KM = 400 // beyond this straight-line distance we never spend a map call
const CONCURRENCY = 4
const CALL_TIMEOUT_MS = 3500

const inflight = new Map()
let failures = []
let breakerUntil = 0

export const originKey = (lat, lng) => `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`
const r1 = (n) => Math.round(n * 10) / 10
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005

function breakerOpen() {
  return Date.now() < breakerUntil
}
function noteFailure() {
  const now = Date.now()
  failures = failures.filter((t) => now - t < 60_000).concat(now)
  if (failures.length >= 5) breakerUntil = now + 60_000
}

async function fetchRoad(origin, shop) {
  if (breakerOpen()) return null
  try {
    const r = await Promise.race([
      directions({ lat: origin.lat, lng: origin.lng }, { lat: shop.lat, lng: shop.lng }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CALL_TIMEOUT_MS)),
    ])
    if (!r?.distanceMeters || !(r.distanceMeters > 0)) return null
    return { km: r.distanceMeters / 1000, minutes: r.durationSeconds ? Math.max(1, Math.round(r.durationSeconds / 60)) : null }
  } catch (e) {
    if (e?.name !== 'OlaNotConfigured' && !String(e?.message).includes('not configured')) noteFailure()
    return null
  }
}

async function compute(key, origin, shop, ctx) {
  const air = haversineKm(origin.lat, origin.lng, shop.lat, shop.lng)
  if (air == null) return null
  let out = null
  if (air <= MAX_ROAD_KM) {
    const road = await fetchRoad(origin, shop)
    if (road) out = { km: road.km, minutes: road.minutes, method: 'ROAD' }
  }
  if (!out) out = { km: air * EST_FACTOR, minutes: air * EST_FACTOR > 300 ? null : Math.max(1, Math.round((air * EST_FACTOR) / 0.5)), method: 'EST' } // ~30 km/h city average
  await query(
    `INSERT INTO address_shop_distances (origin_key, shop_id, origin_lat, origin_lng, shop_lat, shop_lng, km, minutes, method, address_id, user_id, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (origin_key, shop_id) DO UPDATE SET shop_lat = EXCLUDED.shop_lat, shop_lng = EXCLUDED.shop_lng, km = EXCLUDED.km,
       minutes = EXCLUDED.minutes, method = EXCLUDED.method, address_id = COALESCE(EXCLUDED.address_id, address_shop_distances.address_id),
       user_id = COALESCE(EXCLUDED.user_id, address_shop_distances.user_id), computed_at = NOW()`,
    [key, shop.id, origin.lat, origin.lng, shop.lat, shop.lng, out.km.toFixed(2), out.minutes, out.method, ctx.addressId || null, ctx.userId || null]
  ).catch(() => {})
  return out
}

/**
 * @param {{lat:number,lng:number}} origin  customer pin
 * @param {string[]} shopIds
 * @param {{addressId?:string,userId?:string}} ctx
 * @returns {Promise<Record<string,{km:number,minutes:number|null,method:string}>>}
 */
export async function distancesFor(origin, shopIds, ctx = {}) {
  const lat = Number(origin?.lat)
  const lng = Number(origin?.lng)
  const ids = [...new Set((shopIds || []).filter(Boolean))].slice(0, 40)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !ids.length) return {}
  const key = originKey(lat, lng)

  const { rows: shops } = await query(`SELECT id, lat, lng FROM shops WHERE id = ANY($1) AND lat IS NOT NULL AND lng IS NOT NULL`, [ids])
  const { rows: saved } = await query(`SELECT * FROM address_shop_distances WHERE origin_key = $1 AND shop_id = ANY($2)`, [key, ids])
  const savedBy = new Map(saved.map((r) => [r.shop_id, r]))

  const result = {}
  const todo = []
  const now = Date.now()
  for (const sh of shops) {
    const s = savedBy.get(sh.id)
    const fresh = s && same(s.shop_lat, sh.lat) && same(s.shop_lng, sh.lng) && (s.method === 'ROAD' || now - new Date(s.computed_at).getTime() < EST_TTL_MS)
    if (fresh) result[sh.id] = { km: r1(Number(s.km)), minutes: s.minutes, method: s.method }
    else todo.push(sh)
  }

  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const sh = todo[next++]
      const k = `${key}|${sh.id}`
      let p = inflight.get(k)
      if (!p) {
        p = compute(key, { lat, lng }, { id: sh.id, lat: Number(sh.lat), lng: Number(sh.lng) }, ctx).finally(() => inflight.delete(k))
        inflight.set(k, p)
      }
      const out = await p
      if (out) result[sh.id] = { km: r1(out.km), minutes: out.minutes, method: out.method }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
  return result
}
