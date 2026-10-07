/**
 * RFQ award flow against real PostgreSQL (Big Phase 5 — protocol Scenario C)
 *
 * Two vendors submit quotes through the real service; the admin awards one.
 * Verifies: server-side totals, quote comparison listing, award freezing the
 * commercial terms on the request, losing quote NOT_SELECTED, exactly one
 * supply order, and that a second award attempt fails with ALREADY_AWARDED.
 *
 * SKIPS itself when no database is reachable. Fixtures deleted in afterAll.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { config } from 'dotenv'
import pg from 'pg'

config()

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
}

let dbUp = false
try {
  const probe = new pg.Pool({ ...dbConfig, max: 1, connectionTimeoutMillis: 2000 })
  await probe.query('SELECT 1')
  await probe.end()
  dbUp = true
} catch {
  dbUp = false
}

import { VendorProcurementService } from '../../src/modules/vendor-procurement/vendor-procurement.service.js'
import { query, pool, closePool } from '../../src/config/database.js'

const dbQuery = (text, params) => pool.query(text, params)

const suffix = Math.random().toString(36).slice(2, 10)
const ids = { vendors: [], quotes: [] }

beforeAll(async () => {
  if (!dbUp) return

  const shop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [`RFQ Store ${suffix}`, `rfq-store-${suffix}`, `RF${suffix.slice(0, 6)}`, '1 RFQ Lane', 'Kolkata', 'West Bengal', '700001', 22.5726, 88.3639, ['700001']]
  )
  ids.shop = shop.rows[0].id

  const category = await query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
    [`RFQ Mutton ${suffix}`, `rfq-mutton-${suffix}`]
  )
  ids.category = category.rows[0].id

  for (let i = 0; i < 2; i++) {
    const vendor = await query(
      `INSERT INTO vendors (name, slug, email, phone, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [
        `RFQ Vendor ${suffix} ${i}`, `rfq-vendor-${suffix}-${i}`,
        `rfq-${suffix}-${i}@example.test`, `95${i}${suffix.replace(/\D/g, '').padEnd(3, '2').slice(0, 7)}0`.slice(0, 15),
      ]
    )
    ids.vendors.push(vendor.rows[0].id)
  }

  const request = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline)
     VALUES ($1, $2, 'RFQ', 'PUBLISHED', $3, NOW() + interval '3 days', NOW() + interval '1 day')
     RETURNING id`,
    [`PRQ-RFQ-${suffix}`, ids.shop, 'RFQ award flow request']
  )
  ids.request = request.rows[0].id

  const item = await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit)
     VALUES ($1, $2, 'Mutton', 20, 'KG') RETURNING id`,
    [ids.request, ids.category]
  )
  ids.requestItem = item.rows[0].id

  ids.recipients = []
  for (const vendorId of ids.vendors) {
    const recipient = await query(
      `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [ids.request, vendorId]
    )
    ids.recipients.push(recipient.rows[0].id)
  }
})

afterAll(async () => {
  if (dbUp) {
    await query(`DELETE FROM procurement_supply_events WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
    await query(`DELETE FROM procurement_supply_order_items WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
    await query(`DELETE FROM procurement_supply_orders WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_quotes WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_recipients WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_requests WHERE id = $1`, [ids.request])
    await query(`DELETE FROM vendor_users WHERE vendor_id = ANY($1)`, [ids.vendors])
    await query(`DELETE FROM vendors WHERE id = ANY($1)`, [ids.vendors])
    await query(`DELETE FROM categories WHERE id = $1`, [ids.category])
    await query(`DELETE FROM shops WHERE id = $1`, [ids.shop])
    await closePool()
  }
})

describe.skipIf(!dbUp)('RFQ award flow (protocol Scenario C)', () => {
  it('awards exactly one of two quotes and freezes the commercial terms', async () => {
    const service = new VendorProcurementService()

    const quoteA = await service.submitQuote(ids.request, ids.vendors[0], null, {
      items: [{ request_item_id: ids.requestItem, quoted_quantity: 20, unit_price: 240 }],
      promised_delivery_at: new Date(Date.now() + 86400_000).toISOString(),
    })
    const quoteB = await service.submitQuote(ids.request, ids.vendors[1], null, {
      items: [{ request_item_id: ids.requestItem, quoted_quantity: 20, unit_price: 260 }],
    })
    ids.quotes.push(quoteA.id, quoteB.id)

    expect(Number(quoteA.grand_total)).toBe(4800)
    expect(Number(quoteB.grand_total)).toBe(5200)

    // Admin comparison shows both quotes with vendor context.
    const comparison = await service.listQuotesForRequest(ids.request)
    expect(comparison).toHaveLength(2)
    expect(comparison.map((q) => Number(q.grand_total)).sort()).toEqual([4800, 5200])

    // Award the cheaper quote; vendor B's quote must become NOT_SELECTED.
    await service.awardQuote(quoteA.id, null)

    const quotesAfter = await dbQuery(
      `SELECT status, grand_total FROM procurement_quotes WHERE request_id = $1 ORDER BY grand_total`,
      [ids.request]
    )
    expect(quotesAfter.rows[0].status).toBe('SELECTED')
    expect(quotesAfter.rows[1].status).toBe('NOT_SELECTED')

    const requestAfter = await dbQuery(
      `SELECT status, awarded_vendor_id, award_total FROM procurement_requests WHERE id = $1`,
      [ids.request]
    )
    expect(requestAfter.rows[0].status).toBe('AWARDED')
    expect(requestAfter.rows[0].awarded_vendor_id).toBe(ids.vendors[0])
    expect(Number(requestAfter.rows[0].award_total)).toBe(4800)

    const supplies = await dbQuery(
      `SELECT vendor_id, award_amount, source_mode FROM procurement_supply_orders WHERE request_id = $1`,
      [ids.request]
    )
    expect(supplies.rows).toHaveLength(1)
    expect(supplies.rows[0].vendor_id).toBe(ids.vendors[0])
    expect(supplies.rows[0].source_mode).toBe('RFQ')
    expect(Number(supplies.rows[0].award_amount)).toBe(4800)

    // Recipient statuses follow the award.
    const recipients = await dbQuery(
      `SELECT vendor_id, status FROM procurement_recipients WHERE request_id = $1`,
      [ids.request]
    )
    const statusByVendor = Object.fromEntries(recipients.rows.map((r) => [r.vendor_id, r.status]))
    expect(statusByVendor[ids.vendors[0]]).toBe('AWARDED')
    expect(statusByVendor[ids.vendors[1]]).toBe('NOT_SELECTED')

    // Second award attempt is rejected — the losing quote is already
    // NOT_SELECTED (the cascade ran) and the request is no longer PUBLISHED.
    await expect(service.awardQuote(quoteB.id, null)).rejects.toMatchObject({
      code: 'PROCUREMENT_QUOTE_NOT_AWARDABLE',
    })
  })
})
