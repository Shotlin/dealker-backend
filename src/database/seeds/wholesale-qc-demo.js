/**
 * Demo detail for the B2B Marketplace listings (WS-xx products):
 *   - highlights (from each product's specs) so the product page has a Highlights card
 *   - a Dealkr QC report (score + checks + condition notes) on the used / refurbished / open-box ones
 *
 *   node src/database/seeds/wholesale-qc-demo.js   (idempotent)
 */
const { query, pool } = await import('../../config/database.js')

const CHECKS = [
  ['Display & touch', 'No dead pixels, touch responsive'],
  ['Speakers & mic', 'Loud and clear'],
  ['Wi-Fi, Bluetooth & mobile network', 'All connected'],
  ['Biometric unlock', 'Working'],
  ['Charging port', 'Charges at rated speed'],
  ['Cameras', 'Focus and flash working'],
  ['Buttons & sensors', 'All responding'],
  ['IMEI & blacklist check', 'Clean, matches the box'],
]
const REPORTS = {
  REFURBISHED: { score: 94, skin: 'Like new — professionally refurbished', screen: 'Flawless', battery: 100, warranty: '6 Months seller warranty', note: 'Fully tested and restored. New battery and outer shell fitted; original accessories in the box.', acc: 'Original box, charger, USB-C cable' },
  USED_LIKE_NEW: { score: 91, skin: 'Barely any marks', screen: 'Flawless', battery: 93, warranty: '3 Months seller warranty', note: 'Used for a few weeks. No scratches on the screen, tiny hairline mark on the frame.', acc: 'Original box, charger' },
  USED_GOOD: { score: 86, skin: 'Light signs of use', screen: 'Minor hairline scratches', battery: 88, warranty: '3 Months seller warranty', note: 'Light daily use. Screen and body show faint marks; everything works as new.', acc: 'Charger, cable' },
  OPEN_BOX: { score: 96, skin: 'Unused, box opened', screen: 'Flawless', battery: 100, warranty: '1 Year brand warranty', note: 'Box opened for inspection only; never used. All seals and accessories present.', acc: 'Original box, charger, USB cable, manual' },
}

const { rows } = await query(`SELECT p.id AS pid, p.sku, p.condition, p.specifications, sp.id AS spid FROM products p JOIN shop_products sp ON sp.product_id = p.id WHERE p.sku LIKE 'WS-%' AND p.deleted_at IS NULL AND sp.deleted_at IS NULL`)
let hl = 0, qc = 0
for (const r of rows) {
  const spec = r.specifications && typeof r.specifications === 'object' ? r.specifications : {}
  const entries = Object.entries(spec).slice(0, 6)
  if (entries.length) {
    await query('UPDATE products SET highlights = $2 WHERE id = $1', [r.pid, JSON.stringify(Object.fromEntries(entries))])
    hl++
  }
  const rep = REPORTS[r.condition]
  if (!rep) continue
  await query(
    `UPDATE products SET condition_notes = $2, battery_health = $3, warranty_info = $4, accessories_included = $5, has_invoice = TRUE WHERE id = $1`,
    [r.pid, rep.note, rep.battery, rep.warranty, rep.acc])
  await query(
    `UPDATE shop_products SET qc_status = 'QC_PASSED', qc_score = $2, qc_checked_at = NOW(),
            vendor_qc = $3 WHERE id = $1`,
    [r.spid, rep.score, JSON.stringify({ checklist: { 'Body / skin': rep.skin, 'Screen': rep.screen } })])
  await query(`DELETE FROM listing_qc_events WHERE shop_product_id = $1 AND mode = 'AUTO' AND notes = 'demo'`, [r.spid])
  const results = CHECKS.map(([label, detail]) => ({ label, detail, status: 'PASS' }))
  await query(
    `INSERT INTO listing_qc_events (shop_product_id, from_status, to_status, mode, score, notes, results) VALUES ($1,'QC_PENDING','QC_PASSED','AUTO',$2,'demo',$3)`,
    [r.spid, rep.score, JSON.stringify(results)])
  qc++
}
console.log(`highlights on ${hl} listings, QC reports on ${qc}`)
await pool.end()
