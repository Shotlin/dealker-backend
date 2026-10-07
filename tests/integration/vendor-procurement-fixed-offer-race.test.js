/**
 * Fixed-offer first-accept race test (Big Phase 4 — protocol Scenario B)
 *
 * Two vendors accept the same published FIXED_OFFER request through two
 * parallel service calls against the real PostgreSQL instance. The row lock
 * (SELECT … FOR UPDATE) plus the conditional award UPDATE must decide exactly
 * one winner; the loser receives ALREADY_AWARDED and exactly one supply order
 * exists. Blueprint 01 §7.1, §21.1–21.2.
 *
 * SKIPS itself when no database is reachable. Fixture rows are deleted in
 * afterAll (tracked by id, FK-safe order).
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

// Probe at module top level so describe.skipIf is decided before collection.
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

const suffix = Math.random().toString(36).slice(2, 10)
const ids = {}

async function insertFixture() {
  const shop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      `Race Store ${suffix}`, `race-store-${suffix}`, `RS${suffix.slice(0, 6)}`,
      '1 Race Lane', 'Kolkata', 'West Bengal', '700001', 22.5726, 88.3639, ['700001'],
    ]
  )
  ids.shop = shop.rows[0].id

  const category = await query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Race Chicken ${suffix}`, `race-chicken-${suffix}`]
  )
  ids.category = category.rows[0].id

  ids.vendors = []
  for (let i = 0; i < 2; i++) {
    const vendor = await query(
      `INSERT INTO vendors (name, slug, email, phone, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [
        `Race Vendor ${suffix} ${i}`, `race-vendor-${suffix}-${i}`,
        `race-${suffix}-${i}@example.test`, `96${i}${suffix.replace(/\D/g, '').padEnd(3, '8').slice(0, 7)}0`.slice(0, 15),
      ]
    )
    ids.vendors.push(vendor.rows[0].id)
  }

  const request = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline, offer_total)
     VALUES ($1, $2, 'FIXED_OFFER', 'PUBLISHED', $3, NOW() + interval '2 days', NOW() + interval '1 day', 5000)
     RETURNING id`,
    [`PRQ-R-${suffix}`, ids.shop, 'Fixed offer race request']
  )
  ids.request = request.rows[0].id

  const item = await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit, fixed_unit_price, fixed_line_total)
     VALUES ($1, $2, 'Chicken', 20, 'KG', 250, 5000) RETURNING id`,
    [ids.request, ids.category]
  )
  ids.requestItem = item.rows[0].id

  ids.recipients = []
  for (const vendorId of ids.vendors) {
    const recipient = await query(
      `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility)
       VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [ids.request, vendorId]
    )
    ids.recipients.push(recipient.rows[0].id)
  }
}

async function deleteFixture() {
  if (!ids.request) return
  await query(`DELETE FROM procurement_supply_events WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_supply_order_items WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_supply_orders WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_recipients WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_requests WHERE id = $1`, [ids.request])
  await query(`DELETE FROM vendor_users WHERE vendor_id = ANY($1)`, [ids.vendors ?? []])
  await query(`DELETE FROM vendors WHERE id = ANY($1)`, [ids.vendors ?? []])
  await query(`DELETE FROM categories WHERE id = $1`, [ids.category])
  await query(`DELETE FROM shops WHERE id = $1`, [ids.shop])
}

beforeAll(async () => {
  if (!dbUp) return
  await insertFixture()
})

afterAll(async () => {
  if (dbUp) await deleteFixture()
  await closePool()
})

describe.skipIf(!dbUp)('fixed-offer first-accept race (two parallel vendors)', () => {
  it('decides exactly one winner and creates exactly one supply order', async () => {
    const service = new VendorProcurementService()
    const [vendorA, vendorB] = ids.vendors

    const results = await Promise.allSettled([
      service.acceptFixedOffer(ids.request, vendorA, null, 'VENDOR_OWNER'),
      service.acceptFixedOffer(ids.request, vendorB, null, 'VENDOR_OWNER'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ code: 'ALREADY_AWARDED' })

    const winnerVendorId = fulfilled[0].value.request.awarded_vendor_id
    expect([vendorA, vendorB]).toContain(winnerVendorId)

    // Exactly one supply order exists, linked to the winner.
    const supplies = await query(
      `SELECT vendor_id, award_amount, source_mode FROM procurement_supply_orders WHERE request_id = $1`,
      [ids.request]
    )
    expect(supplies.rows).toHaveLength(1)
    expect(supplies.rows[0].vendor_id).toBe(winnerVendorId)
    expect(supplies.rows[0].source_mode).toBe('FIXED_OFFER')
    expect(Number(supplies.rows[0].award_amount)).toBe(5000)

    // Recipient statuses: winner AWARDED, loser NOT_SELECTED.
    const recipients = await query(
      `SELECT vendor_id, status FROM procurement_recipients WHERE request_id = $1 ORDER BY vendor_id`,
      [ids.request]
    )
    const statuses = Object.fromEntries(recipients.rows.map((r) => [r.vendor_id, r.status]))
    expect(statuses[winnerVendorId]).toBe('AWARDED')
    expect(statuses[winnerVendorId === vendorA ? vendorB : vendorA]).toBe('NOT_SELECTED')

    // Request frozen with award values.
    const request = await query(
      `SELECT status, awarded_vendor_id, award_total FROM procurement_requests WHERE id = $1`,
      [ids.request]
    )
    expect(request.rows[0].status).toBe('AWARDED')
    expect(request.rows[0].awarded_vendor_id).toBe(winnerVendorId)
    expect(Number(request.rows[0].award_total)).toBe(5000)
  })
})
