/**
 * Mobile store tab strip clean-up for an electronics marketplace.
 *
 *   npm run seed:mobile-tabs -- --dry-run     show what would change, change nothing
 *   npm run seed:mobile-tabs                  apply
 *
 * Inside Docker:  docker compose exec api node src/database/seeds/mobile-store-tabs.js
 *
 * 1. ARCHIVES (never deletes) the grocery-era tabs Ramadan, Fashion, Beauty, Health and Home of the Mobile store.
 *    Restore any of them from the dashboard (Themes → Tabs → Archived).
 * 2. Keeps All, Mobile and Electronics (creating Mobile/Electronics only if missing), and adds two tabs that match the catalogue: Headphones and Accessories
 *    (chargers, power banks, speakers, mouse, SSD, router, smartwatch). There is no laptop in the catalogue yet,
 *    so no Laptops tab — add one in the dashboard once laptops are listed.
 * 3. A tab with no sections of its own (Mobile, Headphones, Accessories) gets one product grid holding its real
 *    products (found by name). Tabs that already have sections (All, Electronics) are not touched.
 * Idempotent: running it twice changes nothing the second time. Uses the real admin services (cache cleared).
 */

const { query, pool } = await import('../../config/database.js')
const { ThemeTabsService } = await import('../../modules/admin/theme-tabs/theme-tabs.service.js')
const { SectionsRepository } = await import('../../modules/admin/sections/sections.repository.js')
const { cacheDeletePattern } = await import('../../utils/cache.js')

const STORE = 'mobile'
const DRY = process.argv.includes('--dry-run')
const REMOVE = ['ramadan', 'fashion', 'beauty', 'health', 'home']
// Created only when missing (the live server already has Mobile and Electronics).
const NEW_TABS = [
  { key: 'mobile', label: 'Mobile', sort_order: 1 },
  { key: 'electronics', label: 'Electronics', sort_order: 2 },
  { key: 'headphones', label: 'Headphones', sort_order: 3 },
  { key: 'accessories', label: 'Accessories', sort_order: 4 },
]
// Tabs that get a product grid when they have no sections, with the product-name patterns that fill them.
const GRIDS = {
  mobile: {
    title: 'Mobiles',
    like: ['%iphone%', '%galaxy%', '%oneplus%', '%pixel%', '%redmi%', '%xiaomi%', '%realme%', '%vivo %', '%oppo%', '%poco%'],
  },
  electronics: { title: 'Top Electronics', like: ['%'] },
  headphones: {
    title: 'Headphones & Earbuds',
    like: ['%headphone%', '%airpods%', '%earbud%', '%earphone%', '%headset%', '%neckband%', '%buds%'],
  },
  accessories: {
    title: 'Chargers & Accessories',
    like: ['%charger%', '%power adapter%', '%power bank%', '%mouse%', '%ssd%', '%router%', '%cable%', '%smartwatch%', '%speaker%', '%soundbar%'],
  },
}

const tabs = new ThemeTabsService()
const sections = new SectionsRepository()
const log = (...a) => console.log(DRY ? '[dry-run]' : '', ...a)

async function adminId() {
  const { rows } = await query(`SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`)
  return rows[0]?.id || null
}

async function activeTab(key) {
  const { rows } = await query(`SELECT * FROM theme_tabs WHERE store_key = $1 AND key = $2 AND status = 'active' LIMIT 1`, [STORE, key])
  return rows[0] || null
}

async function productIds(like) {
  const { rows } = await query(
    `SELECT p.id FROM products p
      WHERE p.is_active = TRUE AND p.name ILIKE ANY($1)
        AND EXISTS (SELECT 1 FROM shop_products sp WHERE sp.product_id = p.id AND sp.deleted_at IS NULL AND sp.stock_quantity >= 1)
      ORDER BY p.created_at`, [like])
  return rows.map((r) => r.id)
}

async function gridTemplateConfig() {
  // Reuse an existing grid's look (colours, columns) so the new ones match the store.
  const { rows } = await query(
    `SELECT sm.config FROM section_manifests sm JOIN theme_tabs t ON t.id = sm.tab_id
      WHERE t.store_key = $1 AND sm.section_type = 'category_product_grid' AND sm.shop_id IS NULL
      ORDER BY t.status = 'active' DESC, sm.created_at LIMIT 1`, [STORE])
  return rows[0]?.config || { columns: 2 }
}

try {
  const admin = await adminId()

  for (const key of REMOVE) {
    const t = await activeTab(key)
    if (!t) continue
    log(`archive tab "${t.label}" (${key})`)
    if (!DRY) await tabs.archive(t.id, admin, null)
  }

  for (const spec of NEW_TABS) {
    if (await activeTab(spec.key)) continue
    log(`create tab "${spec.label}"`)
    if (!DRY) await tabs.create({ store_key: STORE, key: spec.key, label: spec.label, sort_order: spec.sort_order, status: 'active', merch_config: {} }, admin, null)
  }

  const template = await gridTemplateConfig()
  for (const [key, grid] of Object.entries(GRIDS)) {
    const t = await activeTab(key)
    if (!t) { log(`(tab "${key}" is created above; its grid is added on the real run)`); continue }
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM section_manifests WHERE tab_id = $1 AND shop_id IS NULL`, [t.id])
    if (rows[0].n > 0) { log(`tab "${key}" already has ${rows[0].n} section(s) — left as is`); continue }
    const ids = await productIds(grid.like)
    if (!ids.length) { log(`tab "${key}": no matching in-stock products — grid skipped`); continue }
    log(`tab "${key}": add grid "${grid.title}" with ${ids.length} product(s)`)
    if (!DRY) {
      await sections.create(t.id, {
        section_type: 'category_product_grid',
        visible: true,
        config: { ...template, title: grid.title },
        merch_binding: { source: 'manual', product_ids: ids, category_ids: [], tags: [], limit: Math.min(12, ids.length) },
      })
    }
  }

  if (!DRY) {
    for (const p of ['bakaloo:sections:*', 'bakaloo:tab_manifest:*', 'bakaloo:tab_home:*', 'bakaloo:admin_theme_tabs:*', 'bakaloo:tab_themes']) {
      await cacheDeletePattern(p)
    }
  }
  const { rows: now } = await query(`SELECT key, label, sort_order FROM theme_tabs WHERE store_key = $1 AND status = 'active' ORDER BY sort_order`, [STORE])
  console.log('Active Mobile tabs:', now.map((t) => `${t.label}`).join(' · '))
} catch (err) {
  console.error('mobile-store-tabs failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
  process.exit(process.exitCode || 0)
}
