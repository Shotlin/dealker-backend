import { env } from '../../config/env.js'

/**
 * Single-store mode: Dealker is one e-commerce store (the platform shop,
 * `shops.is_platform = true`) serving all of India — customers are never split
 * across shops by location. The platform shop's `serviceable_pincodes` is an
 * optional delivery restriction: empty = every pincode in India.
 * Switch off with SINGLE_STORE_MODE=false to restore per-location shop matching.
 */
export const isSingleStoreMode = () => env?.SINGLE_STORE_MODE === true

let cache = { at: 0, ids: [] }

/** The platform shop id as a one-element list ([] if none exists). Cached for 60 s. */
export async function getPlatformShopIds() {
  if (Date.now() - cache.at < 60_000 && cache.ids.length) return cache.ids
  // Lazy import: keeps this module cheap to load (and easy to mock in tests).
  const { query } = await import('../../config/database.js')
  const { rows } = await query(
    `SELECT id FROM shops
      WHERE is_platform = true AND is_active = true AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`
  )
  cache = { at: Date.now(), ids: rows.map((r) => r.id) }
  return cache.ids
}

export function clearPlatformShopCache() {
  cache = { at: 0, ids: [] }
}
