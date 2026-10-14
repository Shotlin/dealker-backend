/**
 * Demand ↔ inventory matching (pure functions — no database access).
 *
 * A buying requirement ("50 × iPhone 13 128GB, battery 85%+, original display") is
 * compared with a vendor's live listings so the vendor sees "Match found — you have
 * 6 in stock" before quoting. A listing is:
 *   EXACT  – same model (and variant: Pro / Max / Plus …), storage not contradicting,
 *            condition acceptable, battery not below what the buyer asked for;
 *   CLOSE  – same model but storage differs or battery is below the ask;
 *   null   – a different model/variant, or a condition the buyer ruled out.
 */

const VARIANT_WORDS = new Set(['pro', 'max', 'plus', 'mini', 'ultra', 'fe', 'lite', 'se', 'air', 'fold', 'flip', 'edge', 'neo', 'turbo', 'prime', 'note'])
const NEW_CONDITIONS = ['NEW', 'OPEN_BOX']

const STORAGE_RE = /\b(\d{1,4})\s*(gb|tb)\b/gi

/** "128 GB" / "128gb" / "1TB" → "128GB" / "1TB"; null when none present. */
export function parseStorage(text) {
  if (!text) return null
  const all = [...String(text).matchAll(STORAGE_RE)]
  if (!all.length) return null
  // Phones list RAM + storage ("8GB/256GB"): the larger figure is the storage.
  const gb = (m) => Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1)
  const best = all.reduce((a, b) => (gb(b) > gb(a) ? b : a))
  return `${best[1]}${best[2].toUpperCase()}`
}

const words = (s) => String(s || '').toLowerCase().replace(STORAGE_RE, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)

/** Lower-case model key with storage and brand words removed — "Apple iPhone 13 128GB" + brand Apple → "iphone 13". */
export function modelKey(name, brand) {
  const drop = new Set(words(brand))
  return words(name).filter((w) => !drop.has(w)).join(' ')
}

const asTokens = (key) => (key ? key.split(' ') : [])

/**
 * @param req     { product_name, brand, model_key?, storage?, condition_pref, min_battery_health }
 * @param listing { name, brand, condition, battery_health, storage }
 * @returns { level: 'EXACT'|'CLOSE', reasons: string[] } | null
 */
export function matchListing(req, listing) {
  const drop = new Set([...words(req.brand), ...words(listing.brand)])
  const strip = (name) => words(name).filter((w) => !drop.has(w))
  const want = req.model_key ? asTokens(req.model_key).filter((w) => !drop.has(w)) : strip(req.product_name)
  const have = strip(listing.name)
  if (!want.length || !have.length) return null
  if (!want.every((w) => have.includes(w))) return null

  // "iPhone 13" must not match "iPhone 13 Pro Max": variant words have to agree both ways.
  const variants = (ws) => ws.filter((w) => VARIANT_WORDS.has(w)).sort().join(',')
  if (variants(want) !== variants(have)) return null

  const pref = req.condition_pref || 'ANY'
  const isNew = NEW_CONDITIONS.includes(listing.condition)
  if (pref === 'NEW' && !isNew) return null
  if (pref === 'USED_OR_REFURBISHED' && isNew) return null

  const reasons = ['Model matches']
  let level = 'EXACT'

  const wantStorage = req.storage || parseStorage(req.product_name)
  const haveStorage = listing.storage || parseStorage(listing.name)
  if (wantStorage && haveStorage) {
    if (wantStorage.toUpperCase() === haveStorage.toUpperCase()) reasons.push(`${haveStorage} storage`)
    else { level = 'CLOSE'; reasons.push(`Storage is ${haveStorage} (buyer wants ${wantStorage})`) }
  }

  const minBat = Number(req.min_battery_health) || 0
  if (minBat && listing.battery_health != null) {
    if (Number(listing.battery_health) >= minBat) reasons.push(`Battery ${listing.battery_health}%`)
    else { level = 'CLOSE'; reasons.push(`Battery ${listing.battery_health}% (buyer wants ${minBat}%+)`) }
  }
  return { level, reasons }
}

/**
 * Matches one requirement against many listings.
 * @returns { level, stock, listings } — level is the best level found (null = none),
 *          `stock` counts EXACT matches only (that is what the vendor can promise).
 */
export function matchInventory(req, listings) {
  const hits = []
  for (const l of listings) {
    const m = matchListing(req, l)
    if (m) hits.push({ ...l, level: m.level, reasons: m.reasons })
  }
  hits.sort((a, b) => (a.level === b.level ? b.stock - a.stock : a.level === 'EXACT' ? -1 : 1))
  const exact = hits.filter((h) => h.level === 'EXACT')
  return {
    level: exact.length ? 'EXACT' : hits.length ? 'CLOSE' : null,
    stock: exact.reduce((s, h) => s + Number(h.stock || 0), 0),
    listings: hits,
  }
}

/** Demand tags shown on cards. Bulk = from 20 units; Urgent = flagged by the buyer or needed within 3 days. */
export const BULK_FROM = 20
export function demandTags(r, now = new Date()) {
  const tags = []
  const needBy = r.required_by ? new Date(r.required_by) : null
  const soon = needBy && needBy.getTime() - now.getTime() <= 3 * 86400000
  if (r.is_urgent || soon) tags.push('URGENT')
  if (Number(r.quantity_needed) >= BULK_FROM) tags.push('BULK')
  return tags
}
