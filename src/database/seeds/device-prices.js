/**
 * Catalogue prices for every phone — the Grade-A "max exchange / buyback" price of the TOP storage variant
 * (lower storages step down by sell_settings.variant_step_pct; condition deductions come from the valuation matrix).
 *
 *   node src/database/seeds/device-prices.js            apply (idempotent; never touches price_source = 'admin')
 *   node src/database/seeds/device-prices.js --dry-run  print a summary / sample, change nothing
 *
 * iPhones: the "All iPhone Models Master Catalog & Used Buyback Price Sheet" (Flipkart Auto column, Nov 2026).
 * Everything else has no sheet, so it is ESTIMATED: launch price of the model's class x a used-phone value curve by age
 * (age = rank among its newest-first siblings). Estimated rows are tagged price_source = 'estimate' so staff can review and
 * overwrite them in the dashboard (an edit flips the tag to 'admin' and the seeder leaves it alone).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { getClient, pool } = await import('../../config/database.js')
const DRY = process.argv.includes('--dry-run')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CAT = JSON.parse(fs.readFileSync(path.join(HERE, 'device-catalogue.json'), 'utf8'))
const COLORS = ['Black', 'White', 'Blue', 'Green', 'Red', 'Silver', 'Gold', 'Purple', 'Pink', 'Grey']

// ── iPhone sheet (Flipkart Auto, ₹, top variant) ───────────────────────────
const SHEET = {
  'iPhone Duo': 63150, 'iPhone 18 Pro Max': 63150, 'iPhone 18 Pro': 60500,
  'iPhone 17 Pro Max': 58900, 'iPhone 17 Pro': 54200, 'iPhone Air': 48500, 'iPhone 17': 46750, 'iPhone 17e': 38500,
  'iPhone 16 Pro Max': 52400, 'iPhone 16 Pro': 47800, 'iPhone 16 Plus': 41200, 'iPhone 16': 38900, 'iPhone 16e': 31500,
  'iPhone 15 Pro Max': 44800, 'iPhone 15 Pro': 40500, 'iPhone 15 Plus': 32800, 'iPhone 15': 30400,
  'iPhone 14 Pro Max': 36500, 'iPhone 14 Pro': 33200, 'iPhone 14 Plus': 24900, 'iPhone 14': 22800,
  'iPhone 13 Pro Max': 28500, 'iPhone 13 Pro': 25400, 'iPhone 13': 18900, 'iPhone 13 mini': 15400,
  'iPhone SE (3rd generation, 2022)': 11800, 'iPhone 12 Pro Max': 20500, 'iPhone 12 Pro': 18200, 'iPhone 12': 13900, 'iPhone 12 mini': 10800,
  'iPhone SE (2nd generation, 2020)': 6800, 'iPhone 11 Pro Max': 14500, 'iPhone 11 Pro': 12900, 'iPhone 11': 9800,
  'iPhone XS Max': 8900, 'iPhone XS': 7800, 'iPhone XR': 7200, 'iPhone X': 6900,
  'iPhone 8 Plus': 5400, 'iPhone 8': 4300, 'iPhone 7 Plus': 3600, 'iPhone 7': 2800,
  'iPhone SE (1st generation, 2016)': 1600, 'iPhone 6s Plus': 1900, 'iPhone 6s': 1500, 'iPhone 6 Plus': 1200, 'iPhone 6': 1000,
  'iPhone 5s': 750, 'iPhone 5c': 600, 'iPhone 5': 500, 'iPhone 4s': 500, 'iPhone 4': 400, 'iPhone 3GS': 300, 'iPhone 3G': 300, 'iPhone (1st generation, 2007)': 300,
}
// Models in the sheet but not in the Excel workbooks — added so the lineup is complete.
const EXTRA = [
  { name: 'iPhone Duo', series: 'iPhone 18 Series', order: -3, storage: ['256GB', '512GB', '1TB', '2TB'] },
  { name: 'iPhone 18 Pro Max', series: 'iPhone 18 Series', order: -2, storage: ['256GB', '512GB', '1TB', '2TB'] },
  { name: 'iPhone 18 Pro', series: 'iPhone 18 Series', order: -1, storage: ['256GB', '512GB', '1TB', '2TB'] },
]

// ── Estimator for everything without a sheet price ─────────────────────────
// [regex on "<brand> <name>", launch price ₹ of the class]. First match wins; per-brand fallback below.
const D = (re, p) => [re, p]
const RULES = {
  Samsung: [D(/Z Fold/, 160000), D(/Z Flip/, 100000), D(/(S\d+|Note\d+) Ultra/, 130000), D(/(S\d+|Note\d+)\+/, 95000), D(/S\d+ FE/, 55000), D(/Galaxy S\d+$/, 80000),
    D(/Note\d+$/, 70000), D(/ A5\d/, 42000), D(/ A7\d/, 45000), D(/ A3\d/, 28000), D(/ A2\d/, 20000), D(/ A1\d/, 14000), D(/ A0\d/, 9500),
    D(/ M5\d/, 26000), D(/ M3\d/, 18000), D(/ M[12]\d/, 13000), D(/ M0\d/, 9500), D(/ F5\d/, 26000), D(/ F[23]\d/, 18000), D(/ F1\d/, 13000), D(/ F0\d/, 9500)],
  Apple: [D(/./, 70000)],
  OnePlus: [D(/Open/, 140000), D(/Pro/, 70000), D(/OnePlus \d+(T|R)\b/, 40000), D(/OnePlus \d+$/, 55000), D(/Lite/, 20000), D(/CE/, 25000), D(/N20|N10|N100/, 20000), D(/Nord/, 33000)],
  Google: [D(/Fold/, 175000), D(/Pro XL/, 120000), D(/Pro/, 100000), D(/\da$/, 50000), D(/./, 75000)],
  Xiaomi: [D(/Ultra/, 100000), D(/Fold|Flip|Mix/, 90000), D(/Pro/, 75000), D(/Lite|Civi/, 40000), D(/./, 55000)],
  Redmi: [D(/Note \d+ Pro\+/, 30000), D(/Note \d+ Pro/, 25000), D(/Note/, 17000), D(/Redmi A|\d+C|Go/, 7500), D(/Prime|Power/, 11500), D(/./, 12500)],
  POCO: [D(/F\d+ (Pro|Ultra)/, 45000), D(/F\d/, 32000), D(/X\d+ Pro/, 26000), D(/ X/, 20000), D(/ M/, 12500), D(/ C/, 8500), D(/./, 18000)],
  Vivo: [D(/X Fold/, 140000), D(/X\d+ Ultra/, 100000), D(/X\d+ Pro/, 85000), D(/ X\d/, 65000), D(/V\d+ Pro/, 40000), D(/ V\d/, 30000), D(/ T\d/, 22000), D(/ Y[2-9]\d/, 18000), D(/ Y/, 12500), D(/./, 20000)],
  iQOO: [D(/Neo/, 35000), D(/Pro/, 55000), D(/ Z/, 20000), D(/ U/, 15000), D(/iQOO \d+/, 45000), D(/./, 25000)],
  OPPO: [D(/Find N/, 150000), D(/Find X.*Pro|Find X\d+ Pro/, 100000), D(/Find X/, 75000), D(/Reno\d+ Pro/, 45000), D(/Reno/, 32000), D(/ F\d/, 25000), D(/ K\d/, 20000), D(/ A\d/, 14000), D(/./, 20000)],
  Realme: [D(/GT.*Pro/, 60000), D(/GT/, 40000), D(/Pro\+/, 33000), D(/ Pro/, 25000), D(/Narzo/, 14000), D(/ P\d/, 20000), D(/ C\d/, 9000), D(/ Note/, 8000), D(/realme \d/, 18000), D(/./, 15000)],
  Motorola: [D(/Razr.*(Ultra|Plus|\+)/, 90000), D(/Razr/, 60000), D(/Edge.*(Pro|Ultra|\+)/, 60000), D(/Edge/, 30000), D(/ G\d/, 16000), D(/ E\d/, 9000), D(/./, 15000)],
  Nothing: [D(/\(3\)/, 80000), D(/\(2\)/, 45000), D(/\(1\)/, 35000), D(/a|CMF/, 25000), D(/./, 35000)],
  Infinix: [D(/Zero|GT/, 25000), D(/Note/, 15000), D(/Hot/, 10500), D(/Smart/, 7000), D(/./, 12000)],
  TECNO: [D(/Phantom/, 40000), D(/Camon/, 20000), D(/Pova/, 15000), D(/Spark/, 10000), D(/Pop/, 7000), D(/./, 12000)],
  Lava: [D(/Agni/, 20000), D(/Blaze|Storm/, 12000), D(/./, 8500)],
  itel: [D(/./, 7500)],
  Nokia: [D(/\b[GX]\d/, 20000), D(/./, 11000)],
  HONOR: [D(/Magic/, 85000), D(/ X\d/, 20000), D(/./, 28000)],
  LG: [D(/Wing|V\d+|G\d+/, 55000), D(/./, 22000)],
  Sony: [D(/Xperia 1\b|Xperia 1 /, 100000), D(/Xperia 5/, 70000), D(/Xperia 10/, 40000), D(/./, 55000)],
  ASUS: [D(/ROG/, 80000), D(/Zenfone/, 55000), D(/./, 35000)],
  HMD: [D(/./, 12000)], nubia: [D(/./, 35000)], Micromax: [D(/./, 8000)], HTC: [D(/./, 30000)], Lenovo: [D(/./, 20000)],
  Panasonic: [D(/./, 8000)], Coolpad: [D(/./, 8000)], LeEco: [D(/./, 12000)], Jio: [D(/./, 6000)],
}
const LEGACY_YEARS = { LG: 4, HTC: 5, Sony: 2, Nokia: 1, Panasonic: 4, Coolpad: 4, LeEco: 5, Micromax: 4, Lenovo: 2, ASUS: 1, nubia: 0 }

// Known release years for numbered flagship lines (so a Note8 is not valued like a recent phone).
function releaseYear(m) {
  const n = m.name
  let x
  if ((x = n.match(/^Galaxy S(\d{2})/))) return 2000 + Number(x[1])
  if ((x = n.match(/^Galaxy Note ?(\d+)/))) return Number(x[1]) >= 20 ? 2000 + Number(x[1]) : 2010 + Number(x[1])
  if ((x = n.match(/^Galaxy Z (?:Fold|Flip) ?(\d)/))) return 2018 + Number(x[1])
  if ((x = n.match(/^Pixel (\d+)/))) return 2015 + Number(x[1])
  if (m.brand === 'OnePlus' && (x = n.match(/^OnePlus (\d+)/))) return 2012 + Number(x[1])
  return null
}

const usedValue = (launch, years) => Math.max(0.05, 0.42 * 0.82 ** years) * launch
const round100 = (n) => Math.max(1000, Math.round(n / 100) * 100)

function estimate() {
  const out = new Map()
  const groups = new Map()
  for (const m of CAT.models) {
    if (m.brand === 'Apple') continue
    const rules = RULES[m.brand] || [D(/./, 15000)]
    const idx = rules.findIndex(([re]) => re.test(`${m.brand} ${m.name}`))
    const [, launch] = rules[idx < 0 ? rules.length - 1 : idx]
    const key = `${m.brand}|${m.series}|${launch}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ m, launch })
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.m.order - b.m.order)            // newest first
    list.forEach(({ m, launch }, i) => {
      const ry = releaseYear(m)
      const years = (ry ? Math.max(0, 2026.5 - ry) : Math.min(7, i * 0.85)) + (LEGACY_YEARS[m.brand] || 0)
      out.set(m.name, round100(usedValue(launch, years)))
    })
  }
  return out
}

const est = estimate()
if (DRY) {
  const vals = [...est.values()]
  console.log(`estimated ${vals.length} Android/other models: min ${Math.min(...vals)}, max ${Math.max(...vals)}`)
  for (const n of ['Galaxy S26 Ultra', 'Galaxy S24 Ultra', 'Galaxy S22+', 'Galaxy A55 5G', 'Galaxy M14 5G', 'OnePlus 13', 'OnePlus 11R', 'Pixel 9 Pro', 'Redmi Note 13 Pro 5G', 'Redmi A3', 'V27', 'Reno8 5G', 'Galaxy Note8']) console.log(' ', n, est.get(n))
  process.exit(0)
}

const client = await getClient()
try {
  await client.query('BEGIN')
  let sheet = 0, estimated = 0, kept = 0, added = 0
  for (const e of EXTRA) {
    const r = await client.query(
      `INSERT INTO sell_device_models (name, category, variants, colors, brand, series, display_order, sale_enabled, repair_enabled, is_active)
       VALUES ($1,'Smartphone',$2,$3,'Apple',$4,$5,TRUE,TRUE,TRUE)
       ON CONFLICT (name) DO NOTHING RETURNING id`, [e.name, JSON.stringify(e.storage), JSON.stringify(COLORS), e.series, e.order])
    if (r.rowCount) added++
  }
  const { rows } = await client.query(`SELECT id, name, brand, price_source FROM sell_device_models WHERE category = 'Smartphone'`)
  for (const r of rows) {
    if (r.price_source === 'admin') { kept++; continue }
    const price = SHEET[r.name] ?? est.get(r.name)
    if (price == null) continue
    const src = SHEET[r.name] != null ? 'sheet' : 'estimate'
    await client.query(`UPDATE sell_device_models SET base_price = $2, price_source = $3, updated_at = NOW() WHERE id = $1`, [r.id, price, src])
    if (src === 'sheet') sheet++; else estimated++
  }
  await client.query('COMMIT')
  console.log(`sheet prices ${sheet}, estimated ${estimated}, admin-priced kept ${kept}, models added ${added}`)
} catch (e) {
  await client.query('ROLLBACK').catch(() => {})
  throw e
} finally {
  client.release()
  await pool.end()
}
