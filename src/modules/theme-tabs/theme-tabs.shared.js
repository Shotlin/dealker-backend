export const STORE_KEYS = ['mobile', 'mobile_part', 'accessories', 'electronics', 'repellents', 'marketplace', 'deals', 'brand_store', 'new_arrivals']
/** Store keys the dashboard may create/edit. Marketplace was merged into Mobile (migration 194). */
export const ADMIN_STORE_KEYS = STORE_KEYS.filter((k) => k !== 'marketplace')
export const DEFAULT_STORE_KEY = 'mobile'
export const TAB_STATUSES = ['active', 'archived']

export function getDefaultMerchConfig() {
  return {
    seasonal_mosaic: {
      category_ids: [],
      product_ids: [],
      limit: 8,
    },
    featured: {
      category_ids: [],
      product_ids: [],
      limit: 12,
    },
    deals: {
      category_ids: [],
      product_ids: [],
      limit: 12,
    },
    trending: {
      category_ids: [],
      product_ids: [],
      limit: 6,
    },
    category_rails: [],
  }
}

export function normalizeMerchConfig(input) {
  const base = getDefaultMerchConfig()
  const source = isPlainObject(input) ? input : {}

  return {
    seasonal_mosaic: normalizeSectionConfig(
      source.seasonal_mosaic,
      base.seasonal_mosaic.limit
    ),
    featured: normalizeSectionConfig(source.featured, base.featured.limit),
    deals: normalizeSectionConfig(source.deals, base.deals.limit),
    trending: normalizeSectionConfig(source.trending, base.trending.limit),
    category_rails: normalizeRails(source.category_rails),
  }
}

function normalizeSectionConfig(section, fallbackLimit) {
  const value = isPlainObject(section) ? section : {}

  return {
    category_ids: normalizeStringArray(value.category_ids),
    product_ids: normalizeStringArray(value.product_ids),
    limit: normalizeLimit(value.limit, fallbackLimit),
  }
}

function normalizeRails(rails) {
  if (!Array.isArray(rails)) return []

  return rails
    .map((rail) => {
      const value = isPlainObject(rail) ? rail : {}
      const categoryId = normalizeNullableString(value.category_id)

      if (!categoryId) {
        return null
      }

      return {
        category_id: categoryId,
        product_ids: normalizeStringArray(value.product_ids),
        limit: normalizeLimit(value.limit, 6),
        title: normalizeNullableString(value.title),
      }
    })
    .filter(Boolean)
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []

  return [...new Set(
    value
      .map((item) => `${item || ''}`.trim())
      .filter(Boolean)
  )]
}

function normalizeLimit(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 50)
}

function normalizeNullableString(value) {
  const normalized = `${value || ''}`.trim()
  return normalized || null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
