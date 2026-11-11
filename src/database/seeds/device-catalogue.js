/**
 * Device catalogue import — brands, series, models and storage sizes for Sell, Repair, Exchange, Add-Product, Demand and Auctions.
 *
 *   node src/database/seeds/device-catalogue.js            import / refresh (idempotent, never deletes)
 *   node src/database/seeds/device-catalogue.js --dry-run  print what would change
 *
 * Source: device-catalogue.json, built from the two DMMobile workbooks (Android all brands + iPhone model master).
 * Rows live in `sell_device_models` (stable uuid id, unique name) + `device_brands` (logo, order). Existing priced models are
 * matched to their catalogue name, renamed to it and keep their price; every other model gets base_price NULL
 * ("no catalogue price" -> the Sell flow asks the seller for the price). Brand logos are copied from assets/brand-logos
 * to <uploads>/brands/<slug>.png.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { query, getClient, pool } = await import('../../config/database.js')
const { UPLOAD_DIR, PUBLIC_BASE } = await import('../../modules/uploads/local-uploads.routes.js')

const DRY = process.argv.includes('--dry-run')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const CAT = JSON.parse(fs.readFileSync(path.join(HERE, 'device-catalogue.json'), 'utf8'))
const GENERIC_COLORS = ['Black', 'White', 'Blue', 'Green', 'Red', 'Silver', 'Gold', 'Purple', 'Pink', 'Grey']
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '')
const norm = (s) => slug(String(s).toLowerCase().replace(/\b(galaxy|samsung|apple|oneplus|oppo|vivo|realme|redmi|xiaomi|poco|iqoo|phone|mobile|motorola|moto)\b/g, ''))

const log = (...a) => console.log(...a)

// 1. logos -> uploads/brands
const logoUrl = {}
fs.mkdirSync(path.join(UPLOAD_DIR, 'brands'), { recursive: true })
for (const b of CAT.brands) {
  const src = path.join(ROOT, 'assets', 'brand-logos', `${slug(b.name)}.png`)
  if (fs.existsSync(src)) {
    if (!DRY) fs.copyFileSync(src, path.join(UPLOAD_DIR, 'brands', `${slug(b.name)}.png`))
    logoUrl[b.name] = `${PUBLIC_BASE}/brands/${slug(b.name)}.png`
  } else log('  no logo file for', b.name)
}

const client = await getClient()
try {
  await client.query('BEGIN')

  // 2. brands
  for (const b of CAT.brands) {
    await client.query(
      `INSERT INTO device_brands (name, slug, logo_url, sort_order, popular) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (lower(name)) DO UPDATE SET logo_url = COALESCE(EXCLUDED.logo_url, device_brands.logo_url), sort_order = EXCLUDED.sort_order,
         popular = EXCLUDED.popular, updated_at = NOW()`,
      [b.name, slug(b.name), logoUrl[b.name] || null, b.sort, b.popular])
  }

  // 3. match already-priced smartphones to their catalogue name (keeps price + history), rename them
  const byNorm = new Map(CAT.models.map((m) => [`${slug(m.brand)}:${norm(m.name)}`, m]))
  const { rows: existing } = await client.query(`SELECT id, name, brand FROM sell_device_models WHERE category = 'Smartphone'`)
  let renamed = 0
  for (const e of existing) {
    const brandGuess = slug(e.brand || '')
    const cands = [`${brandGuess}:${norm(e.name)}`, `redmi:${norm(e.name)}`, `${slug(e.name.split(' ')[0])}:${norm(e.name)}`]
    let hit = cands.map((k) => byNorm.get(k)).find(Boolean)
    if (!hit) {   // closest catalogue name of the same brand that starts with this model ("Realme 10 Pro+" -> "realme 10 Pro+ 5G")
      const n = norm(e.name)
      const brands = new Set([brandGuess, 'redmi', slug(e.name.split(' ')[0])])
      const pool = CAT.models.filter((m) => brands.has(slug(m.brand)) && norm(m.name).startsWith(n)).sort((a, b) => norm(a.name).length - norm(b.name).length)
      hit = pool[0]
    }
    if (hit && hit.name !== e.name) {
      const { rows: clash } = await client.query('SELECT 1 FROM sell_device_models WHERE name = $1 AND id <> $2', [hit.name, e.id])
      if (!clash.length) { await client.query('UPDATE sell_device_models SET name = $2, brand = $3 WHERE id = $1', [e.id, hit.name, hit.brand]); renamed++; log(`  matched "${e.name}" -> "${hit.name}"`) }
    }
  }

  // 4. models
  let added = 0, updated = 0
  for (const m of CAT.models) {
    const r = await client.query(
      `INSERT INTO sell_device_models (name, category, variants, colors, base_price, brand, brand_logo_url, series, display_order, sale_enabled, repair_enabled, is_active)
       VALUES ($1,'Smartphone',$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (name) DO UPDATE SET brand = EXCLUDED.brand, brand_logo_url = EXCLUDED.brand_logo_url, series = EXCLUDED.series,
         display_order = EXCLUDED.display_order, sale_enabled = EXCLUDED.sale_enabled, repair_enabled = EXCLUDED.repair_enabled,
         variants = EXCLUDED.variants, updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [m.name, JSON.stringify(m.storage), JSON.stringify(GENERIC_COLORS), m.brand, logoUrl[m.brand] || null, m.series, m.order, m.sale, m.repair, m.active])
    if (r.rows[0].inserted) added++; else updated++
  }
  // other categories (laptop, tablet) keep working: give them a brand logo too when their brand is in the catalogue
  await client.query(`UPDATE sell_device_models m SET brand_logo_url = b.logo_url FROM device_brands b WHERE lower(m.brand) = lower(b.name) AND m.brand_logo_url IS NULL AND b.logo_url IS NOT NULL`)
  log(`brands ${CAT.brands.length} · models added ${added}, refreshed ${updated}, renamed ${renamed}`)
  if (DRY) { await client.query('ROLLBACK'); log('dry run — rolled back') } else { await client.query('COMMIT'); log('done') }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {})
  throw e
} finally {
  client.release()
  await pool.end()
}
