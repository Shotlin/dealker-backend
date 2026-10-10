import { query } from '../config/database.js'

let platformName = { at: 0, name: null }

async function getPlatformShopName() {
  if (Date.now() - platformName.at < 5 * 60_000) return platformName.name
  const { rows } = await query(
    `SELECT name FROM shops WHERE is_platform = true AND is_active = true AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`
  )
  platformName = { at: Date.now(), name: rows[0]?.name ?? null }
  return platformName.name
}

/**
 * Adds the extra fields the app's product card shows to product rows:
 *   sold_by     — the seller: the product's vendor, else its vendor_name, else the platform store
 *   created_at  — so the card can flag recently added products as "NEW"
 *   attributes  — spec list (storage, colour...) for the variant line under the name
 * One extra query per call, keyed by product id; rows without a match are returned unchanged.
 */
export async function withCardFields(products) {
  if (!Array.isArray(products) || products.length === 0) return products
  const ids = [...new Set(products.map((p) => p?.id).filter(Boolean))]
  if (ids.length === 0) return products
  const [{ rows }, storeName] = await Promise.all([
    query(
      `SELECT p.id, p.created_at, p.attributes,
              COALESCE(NULLIF(p.vendor_name, ''), v.name) AS seller
         FROM products p LEFT JOIN vendors v ON v.id = p.owner_vendor_id
        WHERE p.id = ANY($1::uuid[])`,
      [ids]
    ),
    getPlatformShopName(),
  ])
  const byId = new Map(rows.map((r) => [r.id, r]))
  return products.map((p) => {
    const extra = byId.get(p.id)
    if (!extra) return p
    return {
      ...p,
      sold_by: extra.seller || storeName || null,
      created_at: extra.created_at,
      attributes: extra.attributes ?? p.attributes ?? null,
    }
  })
}
