export const ACTIVE_THEME_CACHE_PREFIX = 'bakaloo:active_theme'
export const LEGACY_TAB_CACHE_KEY = 'bakaloo:tab_themes'
export const ADMIN_TAB_THEMES_CACHE_PREFIX = 'bakaloo:admin_theme_tabs'
export const SECTION_CACHE_PREFIX = 'bakaloo:sections'
export const SECTION_PUBLIC_CACHE_PREFIX = 'bakaloo:sections:public'
export const TAB_MANIFEST_CACHE_PREFIX = 'bakaloo:tab_manifest'
export const TAB_HOME_CACHE_PREFIX = 'bakaloo:tab_home'

// Shop-bucketed active-theme cache key. `shopId` null/undefined means the
// platform-default theme (the fallback for anonymous customers and anyone
// with no shop allocation yet) — kept as its own fixed bucket so it behaves
// exactly like the single global key this replaced.
export function getActiveThemeCacheKey(shopId) {
  return `${ACTIVE_THEME_CACHE_PREFIX}:${shopId || 'global'}`
}

export function getAdminTabThemesCacheKey(storeKey = 'all', status = 'all') {
  return `${ADMIN_TAB_THEMES_CACHE_PREFIX}:${storeKey}:${status}`
}

export function getTabManifestCacheKey(storeKey = 'marketplace', shopId = null) {
  // The same visual store can have a different theme for each fulfilment
  // shop. Never let a cached Kolkata manifest be returned to another shop.
  return `${TAB_MANIFEST_CACHE_PREFIX}:${storeKey}:${shopId || 'global'}`
}

export function getSectionCacheKey(tabId) {
  return `${SECTION_CACHE_PREFIX}:${tabId}`
}

export function getSectionPublicCacheKey(storeKey = 'marketplace', tabKey = 'all') {
  return `${SECTION_PUBLIC_CACHE_PREFIX}:${storeKey}:${tabKey}`
}

export function getTabHomeCacheKey(storeKey = 'marketplace', key = 'all') {
  return `${TAB_HOME_CACHE_PREFIX}:${storeKey}:${key}`
}
