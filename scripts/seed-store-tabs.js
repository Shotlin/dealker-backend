import 'dotenv/config'
import { createHash } from 'crypto'
import { query } from '../src/config/database.js'
import { redis } from '../src/config/redis.js'
import { cacheDeletePattern } from '../src/utils/cache.js'
import {
  ACTIVE_THEME_CACHE_KEY,
  LEGACY_TAB_CACHE_KEY,
  getAdminTabThemesCacheKey,
} from '../src/modules/themes/theme-cache.js'

/**
 * Idempotent seed for off_zone, super_mall, and cafe theme tabs + sections.
 * Also ensures each store has an active default "all" theme so the app can
 * resolve header colors and shared theme chrome from the dashboard.
 * Run: npm run seed:stores
 */

const DEFAULT_MERCH_CONFIG = {
  seasonal_mosaic: { category_ids: [], product_ids: [], limit: 8 },
  featured: { category_ids: [], product_ids: [], limit: 12 },
  deals: { category_ids: [], product_ids: [], limit: 12 },
  trending: { category_ids: [], product_ids: [], limit: 6 },
  category_rails: [],
}

const FALLBACK_THEME_TEMPLATE = {
  meta: {
    seasonLabel: 'Summer Sip & Scoop',
    statusBarBrightness: 'light',
  },
  sections: {
    topBar: {
      backgroundColor: '#88D4FE',
      textColor: '#000000',
    },
    storeSelector: {
      backgroundColor: '#88D4FE',
      activeChipColor: '#B1EAFF',
    },
    categoryTabs: {
      textColor: '#111827',
      indicatorColor: '#111827',
    },
    searchZone: {
      backgroundColor: '#B1EAFF',
      waveColor: '#88D4FE',
      searchHints: [
        'fresh vegetables',
        'Amul butter',
        'cold drinks',
        'snacks',
        'dishwash liquid',
        'Safai Abhiyaan products',
      ],
      promoBoxImageUrl: null,
    },
    bannerAnimation: {
      lottieUrl: null,
      containerColor: '#D8F4FF',
      backgroundGradient: ['#B1EAFF', '#A8E6FF'],
    },
    feeStrip: {
      visible: true,
      imageUrl: null,
    },
    seasonalMosaic: {
      containerColor: '#D8F4FF',
      heroTile: {
        title: 'Summer\nCool Deals',
        gradient: ['#3F99FE', '#55C5FD'],
        badgeText: 'BUY 2\nGET 1',
        badgeGradient: ['#FF4CB7', '#D91B83'],
      },
      miniTiles: [
        {
          title: 'Frozen\nFizz',
          gradient: ['#3F99FE', '#55C5FD'],
          imageUrl: null,
        },
        {
          title: 'Scoop\nMagic',
          gradient: ['#4F97FF', '#397BF1'],
          imageUrl: null,
        },
        {
          title: 'Crunch\nBreak',
          gradient: ['#43A5FF', '#2E83F3'],
          imageUrl: null,
        },
        {
          title: 'Dairy\nDaily',
          gradient: ['#5AA8FF', '#4283F3'],
          imageUrl: null,
        },
      ],
    },
    bankOffers: {
      visible: true,
      bannerImageUrls: [],
    },
  },
}

const STORE_THEME_PRESETS = {
  off_zone: {
    name: '50% OFF Zone Default',
    seasonLabel: 'Mega deals',
    backgroundColor: '#FF6B35',
    textColor: '#FFFFFF',
    activeChipColor: '#CC3A00',
    surfaceColor: '#FFE1D6',
    bannerGradient: ['#FF8A5B', '#FF6B35'],
  },
  super_mall: {
    name: 'Super Mall Default',
    seasonLabel: 'All in one store',
    backgroundColor: '#7C3AED',
    textColor: '#FFFFFF',
    activeChipColor: '#5B21B6',
    surfaceColor: '#E9DDFF',
    bannerGradient: ['#9B6BFF', '#7C3AED'],
  },
  cafe: {
    name: 'Cafe Default',
    seasonLabel: 'Hot & fresh',
    backgroundColor: '#92400E',
    textColor: '#FFFFFF',
    activeChipColor: '#6B2E00',
    surfaceColor: '#F4E1D4',
    bannerGradient: ['#B86A30', '#92400E'],
  },
}

const STORES = [
  {
    store_key: 'off_zone',
    tabs: [
      {
        key: 'all',
        label: 'All',
        sort_order: 0,
        sections: [
          { section_type: 'animated_banner', config: { title: '50% OFF Deals', gradient: ['#FF6B35', '#CC3A00'], height: 140 } },
          { section_type: 'product_carousel', config: { title: 'Recommended for you ✨' } },
          { section_type: 'category_product_grid', config: { title: 'Best Deals', columns: 2, limit: 8 } },
          { section_type: 'promo_carousel', config: { title: 'Flash Deals', auto_scroll: true } },
        ],
      },
      {
        key: 'flash_sale',
        label: 'Flash Sale',
        sort_order: 1,
        sections: [
          { section_type: 'animated_banner', config: { gradient: ['#E53935', '#B71C1C'], height: 100 } },
          { section_type: 'product_carousel', config: { title: '⚡ Lightning Deals' } },
          { section_type: 'category_product_grid', config: { columns: 2, limit: 8 } },
        ],
      },
    ],
  },
  {
    store_key: 'super_mall',
    tabs: [
      {
        key: 'all',
        label: 'Mall',
        sort_order: 0,
        sections: [
          { section_type: 'round_category_icons', config: {} },
          { section_type: 'animated_banner', config: { title: 'Super Mall Picks', gradient: ['#7C3AED', '#4C1D95'], height: 120 } },
          { section_type: 'product_carousel', config: { title: 'Under ₹399' } },
          { section_type: 'category_product_grid', config: { title: 'Top Picks', columns: 2, limit: 8 } },
          { section_type: 'seasonal_mosaic', config: { layout_variant: 'hero_plus_four', title: 'Powered By' } },
        ],
      },
      {
        key: 'fashion',
        label: 'Fashion',
        sort_order: 1,
        sections: [
          { section_type: 'animated_banner', config: { gradient: ['#EC4899', '#BE185D'], height: 100 } },
          { section_type: 'product_carousel', config: { title: '👗 Fashion Picks' } },
          { section_type: 'category_product_grid', config: { columns: 2, limit: 8 } },
        ],
      },
      {
        key: 'electronics',
        label: 'Electronics',
        sort_order: 2,
        sections: [
          { section_type: 'animated_banner', config: { gradient: ['#3B82F6', '#1D4ED8'], height: 100 } },
          { section_type: 'product_carousel', config: { title: '🔌 Tech Deals' } },
          { section_type: 'category_product_grid', config: { columns: 2, limit: 8 } },
        ],
      },
    ],
  },
  {
    store_key: 'cafe',
    tabs: [
      {
        key: 'all',
        label: 'All',
        sort_order: 0,
        sections: [
          { section_type: 'round_category_icons', config: {} },
          { section_type: 'seasonal_mosaic', config: { layout_variant: 'hero_plus_four', title: 'POWERED BY' } },
          { section_type: 'category_product_grid', config: { title: 'Top Deals', columns: 2, limit: 8 } },
          { section_type: 'promo_carousel', config: { title: 'Seasonal Specials', auto_scroll: true } },
        ],
      },
      {
        key: 'coffee',
        label: 'Coffee',
        sort_order: 1,
        sections: [
          { section_type: 'animated_banner', config: { gradient: ['#92400E', '#78350F'], height: 100 } },
          { section_type: 'product_carousel', config: { title: '☕ Coffee Collection' } },
        ],
      },
      {
        key: 'snacks',
        label: 'Snacks',
        sort_order: 2,
        sections: [
          { section_type: 'product_carousel', config: { title: '🍿 Snack Time' } },
          { section_type: 'category_product_grid', config: { columns: 2, limit: 8 } },
        ],
      },
    ],
  },
]

let tabsCreated = 0
let sectionsCreated = 0
let tabsSkipped = 0
let defaultThemesCreated = 0
let defaultThemesSkipped = 0

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function generateETag(themeData) {
  return createHash('md5').update(JSON.stringify(themeData)).digest('hex')
}

async function getBaseThemeTemplate() {
  const { rows: [theme] } = await query(
    `SELECT theme_data
     FROM app_themes
     WHERE tab_key = 'all'
       AND status = 'active'
     ORDER BY is_active DESC, updated_at DESC, created_at DESC
     LIMIT 1`
  )

  return clone(theme?.theme_data || FALLBACK_THEME_TEMPLATE)
}

function buildStoreDefaultThemeData(storeKey, baseThemeTemplate) {
  const preset = STORE_THEME_PRESETS[storeKey]
  const themeData = clone(baseThemeTemplate)

  themeData.meta = {
    ...themeData.meta,
    seasonLabel: preset.seasonLabel,
    statusBarBrightness: 'light',
  }

  themeData.sections = {
    ...themeData.sections,
    topBar: {
      ...themeData.sections.topBar,
      backgroundColor: preset.backgroundColor,
      textColor: preset.textColor,
    },
    storeSelector: {
      ...themeData.sections.storeSelector,
      backgroundColor: preset.backgroundColor,
      activeChipColor: preset.activeChipColor,
    },
    categoryTabs: {
      ...themeData.sections.categoryTabs,
      textColor: preset.textColor,
      indicatorColor: preset.textColor,
    },
    searchZone: {
      ...themeData.sections.searchZone,
      backgroundColor: preset.backgroundColor,
      waveColor: preset.backgroundColor,
    },
    bannerAnimation: {
      ...themeData.sections.bannerAnimation,
      containerColor: preset.surfaceColor,
      backgroundGradient: preset.bannerGradient,
    },
    seasonalMosaic: {
      ...themeData.sections.seasonalMosaic,
      containerColor: preset.surfaceColor,
    },
  }

  return themeData
}

async function ensureDefaultTheme(storeKey, baseThemeTemplate) {
  const preset = STORE_THEME_PRESETS[storeKey]
  if (!preset) {
    return
  }

  const { rows: [allTab] } = await query(
    `SELECT id, key, label, sort_order
     FROM theme_tabs
     WHERE store_key = $1
       AND key = 'all'
     LIMIT 1`,
    [storeKey]
  )

  if (!allTab) {
    console.log(`     ⚠️  No "all" tab found for ${storeKey} — default theme skipped`)
    defaultThemesSkipped++
    return
  }

  const { rows: [existingActive] } = await query(
    `SELECT id, name
     FROM app_themes
     WHERE tab_id = $1
       AND ab_variant = 'A'
       AND status = 'active'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [allTab.id]
  )

  if (existingActive) {
    console.log(`     ⏭  Active default theme already exists for "${storeKey}" (id: ${existingActive.id})`)
    defaultThemesSkipped++
    return
  }

  const themeData = buildStoreDefaultThemeData(storeKey, baseThemeTemplate)

  const { rows: [createdTheme] } = await query(
    `INSERT INTO app_themes (
       name,
       theme_data,
       tab_id,
       tab_key,
       tab_label,
       tab_order,
       status,
       ab_variant,
       ab_split_percent,
       etag,
       is_active
     )
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, 'active', 'A', 100, $7, false)
     RETURNING id`,
    [
      preset.name,
      JSON.stringify(themeData),
      allTab.id,
      allTab.key,
      allTab.label,
      allTab.sort_order,
      generateETag(themeData),
    ]
  )

  console.log(`     🎨 Created active default theme for "${storeKey}" (id: ${createdTheme.id})`)
  defaultThemesCreated++
}

async function invalidateThemeCaches() {
  await redis.del(ACTIVE_THEME_CACHE_KEY)
  await redis.del(LEGACY_TAB_CACHE_KEY)
  await redis.del(getAdminTabThemesCacheKey())
  await cacheDeletePattern('bakaloo:admin_theme_tabs:*')
  await cacheDeletePattern('bakaloo:tab_manifest:*')
  await cacheDeletePattern('bakaloo:tab_home:*')
}

console.log('\n🌱  Seeding store tabs...\n')

const baseThemeTemplate = await getBaseThemeTemplate()

for (const store of STORES) {
  console.log(`  📦 Store: ${store.store_key}`)

  for (const tab of store.tabs) {
    const { rows: existing } = await query(
      'SELECT id FROM theme_tabs WHERE store_key = $1 AND key = $2 LIMIT 1',
      [store.store_key, tab.key]
    )

    if (existing.length > 0) {
      console.log(`     ⏭  Tab "${tab.key}" already exists (id: ${existing[0].id}) — skipped`)
      tabsSkipped++
      continue
    }

    const { rows: [newTab] } = await query(
      `INSERT INTO theme_tabs (store_key, key, label, sort_order, status, merch_config)
       VALUES ($1, $2, $3, $4, 'active', $5::jsonb)
       RETURNING id`,
      [store.store_key, tab.key, tab.label, tab.sort_order, JSON.stringify(DEFAULT_MERCH_CONFIG)]
    )
    tabsCreated++
    console.log(`     ✅ Created tab "${tab.key}" (id: ${newTab.id})`)

    for (let i = 0; i < tab.sections.length; i++) {
      const section = tab.sections[i]
      await query(
        `INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config, merch_binding)
         VALUES ($1, $2, $3, true, $4::jsonb, '{}'::jsonb)`,
        [newTab.id, section.section_type, i, JSON.stringify(section.config ?? {})]
      )
      sectionsCreated++
      console.log(`        + ${section.section_type}`)
    }
  }

  await ensureDefaultTheme(store.store_key, baseThemeTemplate)
}

await invalidateThemeCaches()
await redis.quit()

console.log('')
console.log(
  `🏁  Done! Tabs created: ${tabsCreated}, Skipped: ${tabsSkipped}, Sections created: ${sectionsCreated}, Default themes created: ${defaultThemesCreated}, Default themes skipped: ${defaultThemesSkipped}`
)
process.exit(0)
