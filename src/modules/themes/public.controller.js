import { createHash } from 'crypto'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { success, error } from '../../utils/apiResponse.js'
import { logger } from '../../config/logger.js'
import {
  getActiveThemeCacheKey,
  getSectionPublicCacheKey,
  getTabHomeCacheKey,
  getTabManifestCacheKey,
} from './theme-cache.js'
import { STORE_KEYS } from '../theme-tabs/theme-tabs.shared.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'
import { resolveCustomerContext } from '../products/products.controller.js'
import {
  buildCustomerVisibilitySnippet,
  buildShopPriceJoin,
} from '../products/products.repository.js'

const CACHE_TTL = 300

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5B: Safe mobile home payload caps.
//
// These constants define the maximum product count returned by each section
// type in the public mobile home endpoint. Dashboard admins can still
// configure higher limits via merch_config, but the mobile API always clamps
// to these values regardless.
//
// Rationale: Flutter home screen renders at most 12 products per carousel
// and 8 per category rail. Sending more is wasted JSON decode/network work.
// The caps are intentionally generous (not minimal) to ensure sections look
// full on screen.
// ─────────────────────────────────────────────────────────────────────────────
const HOME_CAPS = {
  featured:         12, // horizontal carousel — 12 fills 3 visible + scrollable
  deals:            12, // same
  trending:         12, // same
  seasonal:          8, // mosaic hero+4 pattern
  categoryRail:      8, // 3-column grid shows 6; 8 gives one extra row
  defaultRailItems:  8, // getDefaultCategorySections per-rail limit
  defaultRailCount:  4, // max category rails in fallback
}

// Section-level product count cap applied to every section type from the
// manifest (productCarousel, categoryProductGrid, archedShowcase, etc.).
// The dashboard ProductConfigEditor already clamps its slider to 20 (phase 5D),
// but we enforce a server-side cap here so old/mis-configured records are safe.
const HOME_MANIFEST_SECTION_CAP = 12

export class PublicThemeController {
  constructor() {
    this.feeSettingsService = new FeeSettingsService()
    this.allocationService = new AllocationService(new AllocationRepository())
  }

  /**
   * Resolve which physical shop's theme this request should see. Identical to
   * `_resolveThemeShopId` — a signed-in customer's primary allocation OR a
   * guest's signed storefront token — so `/theme/active`, `/theme/tabs`,
   * sections and tab-home can never disagree about the shop.
   */
  async _resolveShopId(request) {
    return this._resolveThemeShopId(request)
  }

  /**
   * Customer-scoped shop visibility for the home feed's product sections
   * (Trending, Deals, Featured, Seasonal Mosaic, category rails). Mirrors
   * products.service.js#_resolveAllocatedShopIds exactly — this endpoint
   * used to query the master `products` table directly with no shop
   * awareness at all, so a shop with zero shop_products still showed every
   * active product platform-wide. Returns:
   *   - null for anonymous requests or ADMIN/RIDER/shop-staff (unscoped —
   *     matches resolveCustomerContext's role gate on the list endpoints)
   *   - [] when the customer is allocated to zero shops
   *   - [shopId, ...] otherwise
   */
  async _resolveAllocatedShopIds(request) {
    const customerContext = await resolveCustomerContext(request)
    if (!customerContext) return null
    if (Array.isArray(customerContext.shopIds)) {
      return customerContext.shopIds
    }
    try {
      // The customer's ONE storefront shop (primary allocation) — the same
      // set a guest's storefront token carries — not every allocated shop.
      const ids = await this.allocationService.getStorefrontShopIds(customerContext.userId)
      return Array.isArray(ids) ? ids : []
    } catch (err) {
      logger.error(
        { err, userId: customerContext.userId },
        'Failed to resolve customer allocations for home feed; falling back to zero allocations'
      )
      return []
    }
  }

  async getActiveTheme(request, reply) {
    const shopId = await this._resolveShopId(request)
    const cacheKey = getActiveThemeCacheKey(shopId)

    const cached = await redis.get(cacheKey)
    if (cached) {
      return success(JSON.parse(cached), 'Active theme')
    }

    // A shop-specific active theme wins when one exists; otherwise fall
    // back to the platform default (shop_id IS NULL) so a store that never
    // got its own theme still renders normally. Ordered explicitly (rather
    // than relying on UNION ALL row order) so the shop-specific row always
    // wins when both exist.
    const { rows } = await query(
      `SELECT theme_data, (shop_id = $1) AS is_shop_specific
         FROM app_themes
        WHERE is_active = true AND (shop_id = $1 OR shop_id IS NULL)
        ORDER BY is_shop_specific DESC NULLS LAST
        LIMIT 1`,
      [shopId]
    )

    const themeData = rows[0]?.theme_data ?? null

    if (themeData) {
      await redis.set(cacheKey, JSON.stringify(themeData), 'EX', CACHE_TTL)
    }

    return success(themeData, 'Active theme')
  }

  async getStores() {
    const { rows } = await query(
      `SELECT store_key, label, icon_url, sort_order
         FROM storefront_stores
        WHERE is_active = TRUE
        ORDER BY sort_order ASC, label ASC`
    )
    return success({ stores: rows }, 'Storefront stores')
  }

  async getTabThemes(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const shopId = await this._resolveThemeShopId(request)
    const clientETag = request.headers['if-none-match']
    const cacheKey = getTabManifestCacheKey(storeKey, shopId)

    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      const etag = parsed._etag

      if (clientETag && clientETag === etag) {
        reply.code(304)
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      return success(parsed.data, 'Tab themes')
    }

    const rows = await getTabManifestRows(storeKey, shopId)
    const responseData = buildTabManifestResponse(storeKey, rows, shopId)

    // Admin-configurable delivery-time display badge (e.g. "45 mins
    // delivery") shown on the app's home header — a plain manually-set
    // number, not a computed ETA. Reuses fee_settings.delivery_eta_minutes
    // (already existed, "display only" per migration 055) rather than a
    // new column; this is a GLOBAL value so it's a top-level sibling of
    // store_key/tabs, not nested per-tab.
    const feeSettings = await this.feeSettingsService.getGlobal()
    responseData.delivery_eta_minutes = feeSettings.delivery_eta_minutes ?? null

    const etag = createHash('md5').update(JSON.stringify(responseData)).digest('hex')

    await redis.set(
      cacheKey,
      JSON.stringify({ _etag: etag, data: responseData }),
      'EX',
      CACHE_TTL
    )

    if (clientETag && clientETag === etag) {
      reply.code(304)
      return
    }

    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60')
    return success(responseData, 'Tab themes')
  }

  /** Resolve one fulfilment shop for theme/layout selection. Product calls
   * already understand both customer allocations and signed guest tokens;
   * the visual manifest must use the identical scope. */
  async _resolveThemeShopId(request) {
    const customerContext = await resolveCustomerContext(request)
    if (!customerContext) return null

    if (Array.isArray(customerContext.shopIds)) {
      return customerContext.shopIds[0] || null
    }

    if (!customerContext.userId) return null
    try {
      const [shopId] = await this.allocationService.getStorefrontShopIds(customerContext.userId)
      return shopId || null
    } catch (err) {
      logger.error({ err, userId: customerContext.userId }, 'Failed to resolve shop for tab theme lookup')
      return null
    }
  }

  async getTabHomeContent(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const tabKey = `${request.params.key || ''}`.trim()
    const priceMode = request.query?.priceMode === 'wholesale'
      ? 'wholesale'
      : 'retail'

    if (!tabKey) {
      reply.code(400)
      return error('Tab key is required', 'BAD_REQUEST')
    }

    const allocatedShopIds = await this._resolveAllocatedShopIds(request)
    const cacheKey = `${getTabHomeCacheKey(storeKey, tabKey)}:${shopBucketKey(allocatedShopIds)}:${priceMode}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      return success(JSON.parse(cached), 'Tab home content')
    }

    const tab = await getTabDefinition(storeKey, tabKey)
    if (!tab) {
      reply.code(404)
      return error('Tab not found', 'NOT_FOUND')
    }

    const merchConfig = tab.merch_config || {}

    // PHASE 5B: Each resolveSectionProducts call gets the dashboard-configured
    // limit clamped to HOME_CAPS.* — regardless of what the dashboard stored.
    const featuredProducts = await resolveSectionProducts(
      merchConfig.featured,
      () => getFeaturedProducts(HOME_CAPS.featured, allocatedShopIds, priceMode),
      HOME_CAPS.featured,
      allocatedShopIds,
      priceMode
    )
    const dealProducts = await resolveSectionProducts(
      merchConfig.deals,
      () => getDealProducts(HOME_CAPS.deals, allocatedShopIds, priceMode),
      HOME_CAPS.deals,
      allocatedShopIds,
      priceMode
    )
    const trendingProducts = await resolveSectionProducts(
      merchConfig.trending,
      () => getTrendingProducts(HOME_CAPS.trending, allocatedShopIds, priceMode),
      HOME_CAPS.trending,
      allocatedShopIds,
      priceMode
    )
    const seasonalProducts = await resolveSectionProducts(
      merchConfig.seasonal_mosaic,
      async () => mergeUniqueProducts([
        await getDealProducts(HOME_CAPS.seasonal, allocatedShopIds, priceMode),
        await getFeaturedProducts(HOME_CAPS.seasonal, allocatedShopIds, priceMode),
        await getTrendingProducts(HOME_CAPS.seasonal, allocatedShopIds, priceMode),
      ]).slice(0, HOME_CAPS.seasonal),
      HOME_CAPS.seasonal,
      allocatedShopIds,
      priceMode
    )
    const categorySections = await resolveCategorySections(
      merchConfig.category_rails,
      async () => getDefaultCategorySections(
        HOME_CAPS.defaultRailCount,
        HOME_CAPS.defaultRailItems,
        allocatedShopIds,
        priceMode
      ),
      HOME_CAPS.categoryRail,
      allocatedShopIds,
      priceMode
    )

    const responseData = {
      store_key: storeKey,
      tab_key: tab.key,
      // The shop these products were resolved for. Clients compare it with the
      // shop they asked for and refuse to store a mismatching (e.g. anonymous)
      // response under a real shop's cache key.
      shop_id: allocatedShopIds?.[0] ?? null,
      seasonal_products: seasonalProducts,
      featured_products: featuredProducts,
      deal_products: dealProducts,
      trending_products: trendingProducts,
      category_sections: categorySections,
      // PHASE 5E: Future-safe pagination hints.
      // Clients can check has_more to know a "Load more" path is available.
      // The actual load-more endpoint (GET /api/v1/home/sections/:id/items?cursor=)
      // is documented but not yet built — this flag prepares the schema so
      // Flutter can conditionally show load-more controls without a breaking
      // API change later.
      _meta: {
        effective_limits: {
          featured: HOME_CAPS.featured,
          deals: HOME_CAPS.deals,
          trending: HOME_CAPS.trending,
          seasonal: HOME_CAPS.seasonal,
          category_rail: HOME_CAPS.categoryRail,
        },
        has_more: {
          featured: featuredProducts.length >= HOME_CAPS.featured,
          deals: dealProducts.length >= HOME_CAPS.deals,
          trending: trendingProducts.length >= HOME_CAPS.trending,
        },
      },
    }

    // PHASE 5F: Lightweight payload logging for QA/staging.
    // Only logs at debug level — production log level (info/warn) is unaffected.
    _logHomePayload(storeKey, tabKey, responseData)

    await redis.set(cacheKey, JSON.stringify(responseData), 'EX', CACHE_TTL)
    return success(responseData, 'Tab home content')
  }

  async recordAnalytics(request, reply) {
    const events = request.body?.events
    if (!Array.isArray(events) || events.length === 0) {
      return success(null, 'No events')
    }

    const batch = events.slice(0, 50)
    const values = []
    const params = []
    let idx = 1

    for (const event of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push(
        event.theme_id || null,
        event.tab_key || 'unknown',
        event.event_type || 'impression',
        event.user_id || null,
        event.session_id || null,
        normalizeStoreKey(event.store_key),
        event.section_key || null
      )
    }

    await query(
      `INSERT INTO theme_analytics (
         theme_id,
         tab_key,
         event_type,
         user_id,
         session_id,
         store_key,
         section_key
       )
       VALUES ${values.join(', ')}`,
      params
    )

    return success(null, 'Analytics recorded')
  }

  async getSectionManifest(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const shopId = await this._resolveThemeShopId(request)
    const tabKey = `${request.params.tabKey || ''}`.trim()
    const priceMode = request.query?.priceMode === 'wholesale'
      ? 'wholesale'
      : 'retail'

    if (!tabKey) {
      reply.code(400)
      return error('Tab key is required', 'BAD_REQUEST')
    }

    const allocatedShopIds = await this._resolveAllocatedShopIds(request)
    const clientETag = request.headers['if-none-match']
    const cacheKey = `${getSectionPublicCacheKey(storeKey, tabKey)}:${shopBucketKey(allocatedShopIds)}:${priceMode}`

    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      const etag = parsed._etag

      if (clientETag && clientETag === etag) {
        reply.code(304)
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      return success(parsed.data, 'Section manifest')
    }

    const tab = await getTabDefinition(storeKey, tabKey)
    if (!tab) {
      reply.code(404)
      return error('Tab not found', 'NOT_FOUND')
    }

    const { rows } = await query(
      `SELECT
         id,
         section_type AS type,
         sort_order AS "order",
         visible,
         config,
         merch_binding
       FROM section_manifests
       WHERE tab_id = $1
         AND visible = true
         AND shop_id IS NOT DISTINCT FROM (
           CASE WHEN EXISTS (
             SELECT 1 FROM section_manifests scoped
             WHERE scoped.tab_id = $1 AND scoped.shop_id = $2
           ) THEN $2::uuid ELSE NULL END
         )
       ORDER BY sort_order ASC`,
      [tab.id, shopId]
    )

    // Resolve products for sections that have product_ids or category_ids in merch_binding.
    // Without this step the mobile receives only IDs and renders nothing.
    const resolvedSections = await Promise.all(
      rows.map(async (section) => {
        const binding = section.merch_binding || {}
        const productIds = Array.isArray(binding.product_ids) ? binding.product_ids : []
        const categoryIds = Array.isArray(binding.category_ids) ? binding.category_ids : []
        const limit = normalizeLimit(binding.limit, HOME_MANIFEST_SECTION_CAP, HOME_MANIFEST_SECTION_CAP)

        // Static sections do not need products. Product sections with no
        // manual/category binding, however, are still valid dashboard
        // sections: their intended source is the store's live feed (for
        // example Trending or Best Sellers). Resolve that feed here so the
        // mobile receives one self-contained, shop-scoped manifest instead
        // of relying on a second asynchronous home request.
        if (productIds.length === 0 && categoryIds.length === 0) {
          const products = await getImplicitSectionProducts(
            section,
            limit,
            allocatedShopIds,
            priceMode
          )
          if (products.length > 0) {
            return { ...section, products }
          }
          return section
        }

        // Fetch manually pinned products first, preserving dashboard order
        const manualProducts = productIds.length > 0
          ? await getProductsByIds(productIds, allocatedShopIds, priceMode)
          : []
        const seenIds = manualProducts.map((p) => p.id)

        // Fill remaining slots from category if needed
        let products = manualProducts
        if (products.length < limit && categoryIds.length > 0) {
          const fillProducts = await getProductsByCategoryIds(
            categoryIds,
            limit - products.length,
            seenIds,
            allocatedShopIds,
            priceMode
          )
          products = [...manualProducts, ...fillProducts]
        }

        return {
          ...section,
          products: products.slice(0, limit),
        }
      })
    )

    const responseData = {
      tab_key: tabKey,
      store_key: storeKey,
      // See getTabHomeContent: lets clients verify the response's shop scope.
      shop_id: shopId,
      sections: resolvedSections,
    }
    const etag = createHash('md5').update(JSON.stringify(responseData)).digest('hex')

    await redis.set(
      cacheKey,
      JSON.stringify({ _etag: etag, data: responseData }),
      'EX',
      CACHE_TTL
    )

    if (clientETag && clientETag === etag) {
      reply.code(304)
      return
    }

    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60')
    return success(responseData, 'Section manifest')
  }
}

function normalizeStoreKey(storeKey) {
  const normalized = `${storeKey || 'marketplace'}`.trim()
  return STORE_KEYS.includes(normalized) ? normalized : 'marketplace'
}

// Cache-key suffix for the customer's shop-visibility bucket — 'unscoped'
// (anonymous/admin/staff), 'none' (authenticated, zero allocations), or the
// sorted shop ids. Keeps the existing per-store_key/tab_key cache entries
// from being shared across customers who see different shop_products.
function shopBucketKey(allocatedShopIds) {
  if (!Array.isArray(allocatedShopIds)) return 'unscoped'
  if (allocatedShopIds.length === 0) return 'none'
  return [...allocatedShopIds].sort().join('_')
}

async function getTabManifestRows(storeKey, shopId = null) {
  const { rows } = await query(
    `SELECT
       tab.id AS tab_id,
       tab.store_key,
       tab.key AS tab_key,
       tab.label AS tab_label,
       tab.image_url AS tab_icon_url,
       tab.text_color AS tab_text_color,
       tab.sort_order AS tab_order,
       theme_a.id AS theme_id,
       theme_a.ab_variant,
       theme_a.theme_data,
       theme_b.theme_data AS variant_b_theme_data,
       theme_b.ab_split_percent AS variant_b_split
     FROM theme_tabs tab
     LEFT JOIN LATERAL (
       SELECT id, ab_variant, theme_data
       FROM app_themes
       WHERE tab_id = tab.id
         AND status = 'active'
         AND ab_variant = 'A'
         AND (shop_id = $2 OR shop_id IS NULL)
       ORDER BY (shop_id = $2) DESC NULLS LAST, updated_at DESC, created_at DESC
       LIMIT 1
     ) theme_a ON true
     LEFT JOIN LATERAL (
       SELECT theme_data, ab_split_percent
       FROM app_themes
       WHERE tab_id = tab.id
         AND status = 'active'
         AND ab_variant = 'B'
         AND (shop_id = $2 OR shop_id IS NULL)
       ORDER BY (shop_id = $2) DESC NULLS LAST, updated_at DESC, created_at DESC
       LIMIT 1
     ) theme_b ON true
     WHERE tab.store_key = $1
       AND tab.status = 'active'
     ORDER BY tab.sort_order ASC, tab.label ASC`,
    [storeKey, shopId]
  )

  return rows
}

export function buildTabManifestResponse(storeKey, rows, shopId = null) {
  const fallbackTheme =
    rows.find((row) => row.tab_key === 'all' && row.theme_data)?.theme_data ?? null

  const tabs = rows.map((row) => {
    // "All" is a layout fallback. Its header photo must not leak into any
    // other category — INCLUDING a category that has never been given its own
    // theme_data at all (row.theme_data == null). A brand-new tab (created in
    // the builder but never customized) must render All's colors/layout
    // through the normal cascade below, but never its header image, exactly
    // like a tab that HAS its own theme_data with no image of its own. Each
    // category may still explicitly upload its own header image.
    const isolateHeaderImage = row.tab_key !== 'all'
    const themeData = mergeThemeData(
      isolateHeaderImage ? withoutFallbackHeaderImage(fallbackTheme) : fallbackTheme,
      row.theme_data
    )
    const variantBThemeData = mergeThemeData(
      isolateHeaderImage ? withoutFallbackHeaderImage(fallbackTheme) : fallbackTheme,
      row.variant_b_theme_data
    )

    return {
      tab_id: row.tab_id,
      store_key: storeKey,
      theme_id: row.theme_id,
      tab_key: row.tab_key,
      tab_label: row.tab_label,
      tab_icon_url: row.tab_icon_url,
      tab_text_color: row.tab_text_color,
      tab_order: row.tab_order,
      variant: row.ab_variant || 'A',
      theme_data: themeData,
      ...(variantBThemeData
        ? {
            ab_test: {
              variant_b_data: variantBThemeData,
              split_percent: row.variant_b_split || 0,
            },
          }
        : {}),
    }
  })

  return {
    store_key: storeKey,
    shop_id: shopId,
    tabs,
  }
}

// The settings that describe HOW the fallback's header image is laid out
// (extend into the mini promo bar + the exact A/B split heights). They belong
// to that one image, so they must not survive when the image itself is
// stripped — otherwise a category with its own header image, but no toggle of
// its own, would inherit "All"'s extension and split.
const HEADER_IMAGE_LAYOUT_KEYS = [
  'recommendedWidth',
  'topRegionHeight',
  'promoRegionHeight',
  'totalHeight',
]

export function withoutFallbackHeaderImage(themeData) {
  if (!isPlainObject(themeData)) return themeData
  const clone = { ...themeData }
  if (isPlainObject(themeData.sections)) {
    clone.sections = { ...themeData.sections }
    if (isPlainObject(themeData.sections.headerBackground)) {
      const headerBackground = {
        ...themeData.sections.headerBackground,
        imageUrl: null,
        extendToPromoBar: false,
      }
      for (const key of HEADER_IMAGE_LAYOUT_KEYS) delete headerBackground[key]
      clone.sections.headerBackground = headerBackground
    }
  }
  return clone
}

export function mergeThemeData(baseValue, overrideValue) {
  if (overrideValue == null) {
    return baseValue ?? null
  }

  if (Array.isArray(overrideValue)) {
    return overrideValue
  }

  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const merged = { ...baseValue }
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = mergeThemeData(baseValue[key], value)
    }
    return merged
  }

  return overrideValue
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function getTabDefinition(storeKey, tabKey) {
  const { rows: [tab] } = await query(
    `SELECT id, store_key, key, merch_config
     FROM theme_tabs
     WHERE store_key = $1
       AND key = $2
       AND status = 'active'
     LIMIT 1`,
    [storeKey, tabKey]
  )
  return tab || null
}

async function resolveSectionProducts(config, fallbackResolver, cap, allocatedShopIds, priceMode = 'retail') {
  const productIds = Array.isArray(config?.product_ids) ? config.product_ids : []
  const categoryIds = Array.isArray(config?.category_ids) ? config.category_ids : []
  // PHASE 5B: normalizeLimit honours dashboard config but clamps to cap.
  const limit = normalizeLimit(config?.limit, cap ?? HOME_CAPS.featured, cap)

  if (productIds.length === 0 && categoryIds.length === 0) {
    return (await fallbackResolver()).slice(0, limit)
  }

  const manualProducts = await getProductsByIds(productIds, allocatedShopIds, priceMode)
  const seenIds = new Set(manualProducts.map((product) => product.id))

  if (manualProducts.length >= limit || categoryIds.length === 0) {
    return manualProducts.slice(0, limit)
  }

  const fillProducts = await getProductsByCategoryIds(
    categoryIds,
    limit - manualProducts.length,
    [...seenIds],
    allocatedShopIds,
    priceMode
  )

  return [...manualProducts, ...fillProducts].slice(0, limit)
}

/**
 * Resolves the live store catalogue for a dashboard product section that has
 * no explicit merch binding. These are the common "Trending" and "Best
 * Sellers" sections. Keeping this at the API boundary makes every returned
 * product use the selected shop's availability and B2B/B2C price.
 */
async function getImplicitSectionProducts(section, limit, allocatedShopIds, priceMode) {
  const sectionLimit = normalizeLimit(
    section.config?.limit,
    limit || HOME_CAPS.defaultRailItems,
    HOME_MANIFEST_SECTION_CAP
  )

  switch (section.type) {
    case 'trending_products':
      return getTrendingProducts(sectionLimit, allocatedShopIds, priceMode)
    case 'seasonal_mosaic':
      return mergeUniqueProducts([
        await getDealProducts(sectionLimit, allocatedShopIds, priceMode),
        await getFeaturedProducts(sectionLimit, allocatedShopIds, priceMode),
        await getTrendingProducts(sectionLimit, allocatedShopIds, priceMode),
      ]).slice(0, sectionLimit)
    case 'category_product_grid':
    case 'product_carousel':
    case 'arched_product_showcase':
      return mergeUniqueProducts([
        await getFeaturedProducts(sectionLimit, allocatedShopIds, priceMode),
        await getDealProducts(sectionLimit, allocatedShopIds, priceMode),
        await getTrendingProducts(sectionLimit, allocatedShopIds, priceMode),
      ]).slice(0, sectionLimit)
    default:
      return []
  }
}

async function resolveCategorySections(rails, fallbackResolver, railCap, allocatedShopIds, priceMode = 'retail') {
  if (!Array.isArray(rails) || rails.length === 0) {
    return fallbackResolver()
  }

  const sections = []

  for (const rail of rails) {
    if (!rail?.category_id) continue

    // PHASE 5B: each rail limit clamped to railCap.
    const limit = normalizeLimit(rail.limit, HOME_CAPS.categoryRail, railCap)
    const manualProducts = await getProductsByIds(
      Array.isArray(rail.product_ids) ? rail.product_ids : [],
      allocatedShopIds,
      priceMode
    )
    const seenIds = manualProducts.map((product) => product.id)
    const fillProducts =
      manualProducts.length < limit
        ? await getProductsByCategoryIds(
            [rail.category_id],
            limit - manualProducts.length,
            seenIds,
            allocatedShopIds,
            priceMode
          )
        : []

    const products = [...manualProducts, ...fillProducts].slice(0, limit)
    if (products.length === 0) continue

    const title = rail.title || (await getCategoryName(rail.category_id))
    sections.push({
      category_id: rail.category_id,
      title,
      products,
    })
  }

  return sections.length > 0 ? sections : fallbackResolver()
}

async function getProductsByIds(productIds, allocatedShopIds = null, priceMode = 'retail') {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return []
  }

  const params = [productIds]
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
  // Unscoped (anonymous/admin) callers keep the legacy master-catalog stock
  // check; scoped callers rely on the shop's own is_available flag instead
  // (see buildCustomerVisibilitySnippet), matching products.repository.js.
  const legacyStockCheck = allocatedShopIds === null ? 'AND p.stock_quantity > 0' : ''

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.highlights,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       ${legacyStockCheck}
       AND p.id = ANY($1::uuid[])
       ${visibility.sql}
     ORDER BY array_position($1::uuid[], p.id)`,
    params
  )

  return rows
}

/**
 * Products belonging to any of the given categories — either as a
 * product's real/primary category (products.category_id) OR via
 * cross-listing through category_products (the multi-category feature: a
 * product can additionally appear under a category that isn't its primary
 * one, e.g. "Exotic Vegetables" cross-listing a product whose real
 * category is "Fresh Vegetables"). Missing this half of the union was the
 * root cause of cross-listed products never showing up in category-bound
 * home sections/widgets even though they correctly appear on the regular
 * category browse page (which already unions both — see
 * categories.repository.js#findProducts).
 *
 * When multiple categoryIds are given, results are interleaved fairly
 * across categories (every category's #1 pick before any category's #2
 * pick, etc.) via a per-category ROW_NUMBER, rather than one global
 * ORDER BY/LIMIT — otherwise a single large/high-selling category could
 * crowd out every product from the other requested categories.
 */
export async function getProductsByCategoryIds(categoryIds, limit, excludeIds = [], allocatedShopIds = null, priceMode = 'retail') {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0 || limit <= 0) {
    return []
  }

  const params = [categoryIds, limit]
  let excludeClause = ''
  if (excludeIds.length > 0) {
    params.push(excludeIds)
    excludeClause = ` AND NOT (p.id = ANY($${params.length}::uuid[]))`
  }

  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
  const legacyStockCheck = allocatedShopIds === null ? 'AND p.stock_quantity > 0' : ''

  const { rows } = await query(
    `WITH matches AS (
       SELECT p.id AS product_id, cat.id AS matched_category_id, cat.ord
       FROM unnest($1::uuid[]) WITH ORDINALITY AS cat(id, ord)
       JOIN products p ON (
         p.category_id = cat.id
         OR EXISTS (
           SELECT 1 FROM category_products cp
           WHERE cp.product_id = p.id AND cp.category_id = cat.id
         )
       )
       WHERE p.is_active = true ${legacyStockCheck}${excludeClause}
         ${visibility.sql}
     ),
     best_match AS (
       -- A product reachable via more than one of the requested categories
       -- (e.g. cross-listed into two of them) keeps only its first match,
       -- by input order, so it's never returned twice.
       SELECT DISTINCT ON (product_id) product_id, matched_category_id
       FROM matches
       ORDER BY product_id, ord ASC
     ),
     ranked AS (
       SELECT
         p.id,
         p.name,
         p.slug,
         ${shopPrice.priceExpr} AS price,
         ${shopPrice.salePriceExpr} AS sale_price,
         ${shopPrice.stockExpr} AS stock_quantity,
         p.unit,
         p.thumbnail_url,
         p.category_id,
         c.name AS category_name,
         COALESCE(p.images, '[]'::jsonb) AS images,
         COALESCE(p.tags, ARRAY[]::text[]) AS tags,
         p.is_active,
         p.is_featured,
         p.total_sold,
         p.created_at,
         p.description,
         p.ingredients,
         p.nutrition_info,
         p.highlights,
         p.storage_instructions,
         p.product_family_id,
         pf.name AS family_name,
         p.option_label,
         p.option_sort_order,
         p.is_default_option,
         p.food_type,
         p.origin_tag,
         p.custom_badges,
         p.display_delivery_minutes,
         p.net_quantity,
         p.brand,
         p.brand_logo_url,
         p.avg_rating,
         p.rating_count,
         COALESCE(
           (SELECT COUNT(*)::int FROM products ps
            WHERE ps.product_family_id = p.product_family_id
              AND ps.is_active = true AND ps.stock_quantity > 0),
           1
         ) AS option_count,
         ROW_NUMBER() OVER (
           PARTITION BY bm.matched_category_id
           ORDER BY p.is_featured DESC, p.total_sold DESC, p.created_at DESC
         ) AS local_rank
       FROM best_match bm
       JOIN products p ON p.id = bm.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
     )
     SELECT
       id, name, slug, price, sale_price, stock_quantity, unit, thumbnail_url,
       category_id, category_name, images, tags, is_active, is_featured,
       total_sold, description, ingredients, nutrition_info, highlights, storage_instructions,
       product_family_id, family_name, option_label, option_sort_order,
       is_default_option, food_type, origin_tag, custom_badges,
       display_delivery_minutes, net_quantity, brand, brand_logo_url,
       avg_rating, rating_count, option_count
     FROM ranked
     ORDER BY local_rank ASC, is_featured DESC, total_sold DESC, created_at DESC
     LIMIT $2`,
    params
  )

  return rows
}

async function getFeaturedProducts(limit, allocatedShopIds = null, priceMode = 'retail') {
  const params = []
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
  const legacyStockCheck = allocatedShopIds === null ? 'AND p.stock_quantity > 0' : ''
  params.push(limit)
  const limitIdx = params.length

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.highlights,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       ${legacyStockCheck}
       AND p.is_featured = true
       ${visibility.sql}
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $${limitIdx}`,
    params
  )

  return rows
}

async function getDealProducts(limit, allocatedShopIds = null, priceMode = 'retail') {
  const params = []
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
  const legacyStockCheck = allocatedShopIds === null ? 'AND p.stock_quantity > 0' : ''
  params.push(limit)
  const limitIdx = params.length

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.highlights,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       ${legacyStockCheck}
       AND p.sale_price IS NOT NULL
       AND p.sale_price < p.price
       ${visibility.sql}
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $${limitIdx}`,
    params
  )

  return rows
}

async function getTrendingProducts(limit, allocatedShopIds = null, priceMode = 'retail') {
  const params = []
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
  const legacyStockCheck = allocatedShopIds === null ? 'AND p.stock_quantity > 0' : ''
  params.push(limit)
  const limitIdx = params.length

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.highlights,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       ${legacyStockCheck}
       ${visibility.sql}
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $${limitIdx}`,
    params
  )

  return rows
}

async function getDefaultCategorySections(limitSections, itemsPerSection, allocatedShopIds = null, priceMode = 'retail') {
  const { rows: categories } = await query(
    `SELECT
       c.id,
       c.name
     FROM categories c
     WHERE c.is_active = true
       AND c.parent_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM products p
         WHERE p.category_id = c.id
           AND p.is_active = true
           AND p.stock_quantity > 0
       )
     ORDER BY c.sort_order ASC, c.name ASC
     LIMIT $1`,
    [limitSections ?? HOME_CAPS.defaultRailCount]
  )

  const perRail = itemsPerSection ?? HOME_CAPS.defaultRailItems
  const sections = []
  for (const category of categories) {
    // PHASE 5B: use configurable per-rail cap.
    const products = await getProductsByCategoryIds([category.id], perRail, [], allocatedShopIds, priceMode)
    if (products.length === 0) continue
    sections.push({
      category_id: category.id,
      title: category.name,
      products,
    })
  }

  return sections
}

async function getCategoryName(categoryId) {
  const { rows: [category] } = await query(
    'SELECT name FROM categories WHERE id = $1 LIMIT 1',
    [categoryId]
  )
  return category?.name || 'Category'
}

function mergeUniqueProducts(groups) {
  const seen = new Set()
  const merged = []

  for (const group of groups) {
    for (const product of group) {
      if (!seen.has(product.id)) {
        seen.add(product.id)
        merged.push(product)
      }
    }
  }

  return merged
}

/**
 * PHASE 5B: normalizeLimit — parse dashboard limit, apply safe mobile cap.
 *
 * @param {any}    value    - raw dashboard config value
 * @param {number} fallback - default when value is absent/invalid
 * @param {number} [cap]    - optional hard ceiling (overrides max=50 for mobile home)
 */
function normalizeLimit(value, fallback, cap) {
  const parsed = Number(value)
  const resolved = (!Number.isFinite(parsed) || parsed <= 0) ? fallback : Math.trunc(parsed)
  // If a per-context cap is provided, honour it; otherwise keep the legacy 50 ceiling
  // so non-home endpoints (admin, full category pages) are unchanged.
  const ceiling = (typeof cap === 'number' && cap > 0) ? cap : 50
  return Math.min(Math.max(resolved, 1), ceiling)
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5F: Lightweight home payload debug logging.
// Only fires at Pino 'debug' level — production deployments set LOG_LEVEL=info
// so this is zero-cost in prod. Staging/QA can set LOG_LEVEL=debug to see it.
// ─────────────────────────────────────────────────────────────────────────────
function _logHomePayload(storeKey, tabKey, data) {
  if (!logger.isLevelEnabled?.('debug') && logger.level !== 'debug') return

  const totalProducts =
    (data.featured_products?.length ?? 0) +
    (data.deal_products?.length ?? 0) +
    (data.trending_products?.length ?? 0) +
    (data.seasonal_products?.length ?? 0) +
    (data.category_sections ?? []).reduce((sum, s) => sum + (s.products?.length ?? 0), 0)

  const approxBytes = JSON.stringify(data).length

  logger.debug(
    {
      storeKey,
      tabKey,
      counts: {
        featured: data.featured_products?.length ?? 0,
        deals: data.deal_products?.length ?? 0,
        trending: data.trending_products?.length ?? 0,
        seasonal: data.seasonal_products?.length ?? 0,
        categorySections: data.category_sections?.length ?? 0,
        categoryRailProducts: (data.category_sections ?? []).map(s => s.products?.length ?? 0),
      },
      totalProducts,
      approxBytes,
      action: 'tab_home_content.payload',
    },
    `[home-payload] ${tabKey}@${storeKey}: ${totalProducts} products, ~${Math.round(approxBytes / 1024)}KB`
  )
}
