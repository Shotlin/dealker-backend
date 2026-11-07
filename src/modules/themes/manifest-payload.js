// Pure helpers that keep the home/section manifest small and cacheable.
// No I/O here on purpose, so they are cheap to unit-test.

// ── ETag helpers ────────────────────────────────────────────────────────────
//
// The manifest used to send a bare md5 as its ETag (no quotes). nginx's gzip
// filter drops any ETag that is not a quoted strong validator, so every client
// that asked for gzip — i.e. every phone — never received it, never sent
// If-None-Match back, and re-downloaded + re-parsed the whole manifest on every
// launch. A quoted ETag survives (nginx turns it into a weak W/"…" tag), and the
// comparison below accepts the strong, weak and legacy-unquoted spellings.

export function quoteEtag(hex) {
  return `"${hex}"`
}

function normalizeEtag(value) {
  return `${value}`.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1')
}

/** True when an If-None-Match header lists the given (unquoted) etag. Weak comparison. */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false
  const header = `${ifNoneMatch}`.trim()
  if (header === '*') return true
  const target = normalizeEtag(etag)
  return header.split(',').some((candidate) => normalizeEtag(candidate) === target)
}

// ── Card-sized products ─────────────────────────────────────────────────────
//
// Home cards never show a product's long description, ingredients, nutrition
// table or storage notes (the product page re-fetches the full product by id),
// yet each of those fields was shipped with every card — 8+ times over.

const DESCRIPTION_SNIPPET_CHARS = 160
const MAX_CARD_IMAGES = 3

export function slimCardProduct(product) {
  if (!product || typeof product !== 'object') return product
  const slim = { ...product }
  delete slim.ingredients
  delete slim.nutrition_info
  delete slim.storage_instructions
  if (typeof slim.description === 'string' && slim.description.length > DESCRIPTION_SNIPPET_CHARS) {
    // Kept (truncated) because the app's seasonal mosaic keyword-matches on it.
    slim.description = slim.description.slice(0, DESCRIPTION_SNIPPET_CHARS)
  }
  if (Array.isArray(slim.images) && slim.images.length > MAX_CARD_IMAGES) {
    slim.images = slim.images.slice(0, MAX_CARD_IMAGES)
  }
  return slim
}

function looksLikeProduct(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && 'slug' in value && 'price' in value
}

function mapProducts(node, visitProductList) {
  if (Array.isArray(node)) return node.map((item) => mapProducts(item, visitProductList))
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'products' && Array.isArray(value) && value.every(looksLikeProduct)) {
      out[key] = visitProductList(value)
    } else {
      out[key] = mapProducts(value, visitProductList)
    }
  }
  return out
}

/** Slim every product list inside a manifest. Keeps the exact legacy structure. */
export function slimManifestProducts(manifestData) {
  return mapProducts(manifestData, (list) => list.map(slimCardProduct))
}

/**
 * Compact form: every `products: [{…}, …]` list becomes `products: ["@key", …]` and the
 * objects move once into `product_pool`. A product appearing in 8 sections is sent once.
 * Two different payloads for the same product id (never expected, but possible) get
 * distinct pool keys, so the client can always rebuild the exact original lists.
 */
export function compactManifest(manifestData) {
  const pool = {}
  const keyByJson = new Map()
  const usedKeys = new Set()

  const poolKeyFor = (product) => {
    const json = JSON.stringify(product)
    const known = keyByJson.get(json)
    if (known) return known
    let key = product.id
    for (let n = 2; usedKeys.has(key); n += 1) key = `${product.id}~${n}`
    usedKeys.add(key)
    keyByJson.set(json, key)
    pool[key] = product
    return key
  }

  // References are "@<key>" so they can never be mistaken for a plain list of ids.
  const compacted = mapProducts(manifestData, (list) => list.map((product) => `@${poolKeyFor(product)}`))
  return { ...compacted, product_pool: pool }
}

// ── Memo for the derived (compact) body ─────────────────────────────────────
// The derived body is a pure function of the cached manifest, whose etag changes
// whenever its content does. Keep a few recent ones so we do not recompute per request.

const MEMO_LIMIT = 24
const memo = new Map()

export function memoizeByEtag(etag, build) {
  if (memo.has(etag)) return memo.get(etag)
  const value = build()
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value)
  memo.set(etag, value)
  return value
}
