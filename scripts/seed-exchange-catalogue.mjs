/**
 * Adds everyday-device trade-in models (headphones, smartwatches, speakers) to the exchange catalogue
 * and, if no exchange programme exists yet, creates starter programmes by matching your category names.
 * Safe to re-run: models are upserted by name, programmes are only created when the table is empty.
 * Everything here is editable afterwards from the dashboard (Sell & Exchange settings).
 *
 *   node scripts/seed-exchange-catalogue.mjs
 *
 * Base price = what the device fetches in mint condition (top variant); the valuation engine then
 * deducts for age, scratches, battery, missing box, etc.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, pool } from '../src/config/database.js'

const std = ['Standard']
const MODELS = [
  // [name, brand, type, base price, variants, colours]
  ['boAt Rockerz 450', 'boAt', 'Headphones', 1500, std, ['Black', 'Blue', 'Red']],
  ['boAt Airdopes 141', 'boAt', 'Headphones', 1200, std, ['Black', 'White']],
  ['boAt Rockerz 255 Pro+', 'boAt', 'Headphones', 1300, std, ['Black', 'Blue', 'Green']],
  ['JBL Tune 510BT', 'JBL', 'Headphones', 2000, std, ['Black', 'Blue', 'White']],
  ['JBL Tune 760NC', 'JBL', 'Headphones', 5500, std, ['Black', 'Blue']],
  ['Sony WH-CH520', 'Sony', 'Headphones', 3500, std, ['Black', 'Blue', 'White']],
  ['Sony WH-1000XM4', 'Sony', 'Headphones', 18000, std, ['Black', 'Silver']],
  ['Sony WH-1000XM5', 'Sony', 'Headphones', 24000, std, ['Black', 'Silver']],
  ['Apple AirPods (2nd gen)', 'Apple', 'Headphones', 7000, std, ['White']],
  ['Apple AirPods (3rd gen)', 'Apple', 'Headphones', 12000, std, ['White']],
  ['Apple AirPods Pro (2nd gen)', 'Apple', 'Headphones', 17000, std, ['White']],
  ['Samsung Galaxy Buds2', 'Samsung', 'Headphones', 6500, std, ['Graphite', 'White', 'Olive']],
  ['Samsung Galaxy Buds FE', 'Samsung', 'Headphones', 5000, std, ['Graphite', 'White']],
  ['OnePlus Nord Buds 2', 'OnePlus', 'Headphones', 2200, std, ['Black', 'White']],
  ['OnePlus Buds Z2', 'OnePlus', 'Headphones', 3500, std, ['Black', 'White']],
  ['Noise Buds VS104', 'Noise', 'Headphones', 1000, std, ['Black', 'White']],
  ['realme Buds T300', 'Realme', 'Headphones', 2500, std, ['Black', 'White', 'Blue']],
  ['Nothing Ear (a)', 'Nothing', 'Headphones', 5000, std, ['Black', 'White', 'Yellow']],
  ['Apple Watch SE (2nd gen)', 'Apple', 'Smartwatch', 22000, ['40mm', '44mm'], ['Midnight', 'Starlight', 'Silver']],
  ['Apple Watch Series 9', 'Apple', 'Smartwatch', 35000, ['41mm', '45mm'], ['Midnight', 'Starlight', 'Pink']],
  ['Samsung Galaxy Watch6', 'Samsung', 'Smartwatch', 22000, ['40mm', '44mm'], ['Graphite', 'Gold', 'Silver']],
  ['Noise ColorFit Pro 4', 'Noise', 'Smartwatch', 2500, std, ['Black', 'Blue', 'Silver']],
  ['boAt Wave Call 2', 'boAt', 'Smartwatch', 1500, std, ['Black', 'Blue']],
  ['Fire-Boltt Ninja Call Pro', 'Fire-Boltt', 'Smartwatch', 1200, std, ['Black', 'Gold']],
  ['Amazfit Bip 5', 'Amazfit', 'Smartwatch', 3500, std, ['Black', 'Cream']],
  ['JBL Flip 6', 'JBL', 'Speaker', 9000, std, ['Black', 'Blue', 'Red']],
  ['JBL Go 3', 'JBL', 'Speaker', 2500, std, ['Black', 'Blue', 'Red']],
  ['boAt Stone 352', 'boAt', 'Speaker', 1200, std, ['Black', 'Blue']],
  ['Sony SRS-XB13', 'Sony', 'Speaker', 3000, std, ['Black', 'Blue']],
  ['Marshall Emberton', 'Marshall', 'Speaker', 11000, std, ['Black', 'Cream']],
  ['Apple HomePod mini', 'Apple', 'Speaker', 7500, std, ['Space Grey', 'White']],
]

for (const [name, brand, category, price, variants, colors] of MODELS) {
  await query(
    `INSERT INTO sell_device_models (name, category, variants, colors, base_price, brand)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET brand = COALESCE(sell_device_models.brand, EXCLUDED.brand)`,
    [name, category, JSON.stringify(variants), JSON.stringify(colors), price, brand]
  )
}
// Brand logos: copy assets/brand-logos/<brand>.png into the uploads folder and point models without a logo at it.
//   UPLOAD_DIR        where the API serves /uploads from   (default ./uploads)
//   UPLOADS_BASE_URL  public URL of that folder             (default http://localhost:4500/uploads)
const logoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/brand-logos')
const uploadDir = path.join(process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads'), 'brands')
const baseUrl = (process.env.UPLOADS_BASE_URL || 'http://localhost:4500/uploads').replace(/\/$/, '')
fs.mkdirSync(uploadDir, { recursive: true })
const { rows: brands } = await query(`SELECT DISTINCT brand FROM sell_device_models WHERE brand IS NOT NULL AND brand_logo_url IS NULL`)
let logos = 0
for (const { brand } of brands) {
  const slug = brand.toLowerCase().replace(/[^a-z0-9]/g, '')
  const file = path.join(logoDir, `${slug}.png`)
  if (!fs.existsSync(file)) continue
  fs.copyFileSync(file, path.join(uploadDir, `${slug}.png`))
  await query(`UPDATE sell_device_models SET brand_logo_url = $2 WHERE brand = $1 AND brand_logo_url IS NULL`, [brand, `${baseUrl}/brands/${slug}.png`])
  logos++
}
console.log(`Brand logos linked: ${logos} of ${brands.length} brands (the rest show a letter badge until a logo is added)`)
console.log(`Catalogue: ${MODELS.length} everyday-device models ready`)

const { rows: existing } = await query('SELECT COUNT(*)::int AS n FROM exchange_programs')
if (existing[0].n === 0) {
  const cats = async (patterns) => (await query(
    `SELECT id, name FROM categories WHERE is_active = TRUE AND name ~* $1 ORDER BY name`, [patterns])).rows
  const starters = [
    { name: 'Phone & tablet exchange', deviceTypes: ['Smartphone', 'Tablet'], match: '^(mobiles?|smartphones?|phones?|mobiles? ?& ?tablets?|tablets?)$', pct: 100 },
    { name: 'Laptop exchange', deviceTypes: ['Laptop'], match: '^laptops?$', pct: 100 },
    { name: 'Headphone & earbud exchange', deviceTypes: ['Headphones'], match: 'head ?phones?|ear ?buds?|ear ?phones?|tws|neckbands?|audio', pct: 60 },
    { name: 'Smartwatch exchange', deviceTypes: ['Smartwatch'], match: 'watch|wearable', pct: 60 },
    { name: 'Speaker exchange', deviceTypes: ['Speaker'], match: 'speaker|soundbar', pct: 60 },
  ]
  for (const s of starters) {
    const found = await cats(s.match)
    if (!found.length) { console.log(`Programme "${s.name}": no matching category, skipped`); continue }
    await query(
      `INSERT INTO exchange_programs (name, device_types, category_ids, max_value_pct) VALUES ($1,$2,$3::uuid[],$4)`,
      [s.name, s.deviceTypes, found.map((c) => c.id), s.pct]
    )
    console.log(`Programme "${s.name}" -> ${found.map((c) => c.name).join(', ')}`)
  }
} else {
  console.log(`Programmes already exist (${existing[0].n}) — left untouched`)
}
await pool.end()
