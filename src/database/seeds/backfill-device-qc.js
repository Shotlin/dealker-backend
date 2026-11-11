/**
 * Gives EVERY vendor's used / refurbished / open-box listing one default QC report per unit in stock
 * (flagged auto_filled until the vendor inspects the device). Brand-new listings are left alone.
 *   node src/database/seeds/backfill-device-qc.js
 */
const { pool } = await import('../../config/database.js')
const { backfillAll } = await import('../../modules/listing-units/units.service.js')
const out = await backfillAll()
console.table(out)
console.log(`vendors: ${Object.keys(out).length}, listings: ${Object.values(out).reduce((n, v) => n + v.listings, 0)}, devices: ${Object.values(out).reduce((n, v) => n + v.devices, 0)}`)
await pool.end()
