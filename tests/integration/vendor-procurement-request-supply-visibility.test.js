/**
 * getRequest's `supply_order` field against real PostgreSQL.
 *
 * Guards the fix for a real, live-reported gap: the store/admin-facing
 * request-detail response had no visibility at all into what the awarded
 * vendor was actually doing after award — an admin had no way to answer
 * "did the vendor accept? are they processing? has a video been
 * submitted? has it shipped?" from the request they were looking at.
 * Covers: no supply order before award -> null; after award -> the real
 * supply order with its live status, items, and event timeline; status
 * changes are reflected on the next fetch (no caching gap).
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
import { query, closePool } from '../../src/config/database.js'

const suffix = Math.random().toString(36).slice(2, 10)
const ids = {}

beforeAll(async () => {
  if (!dbUp) return

  const shop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [`Visibility Store ${suffix}`, `visibility-store-${suffix}`, `VS${suffix.slice(0, 6)}`, '1 Visibility Lane', 'Kolkata', 'West Bengal', '700001', 22.5726, 88.3639, ['700001']]
  )
  ids.shop = shop.rows[0].id

  const category = await query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Visibility Chicken ${suffix}`, `visibility-chicken-${suffix}`]
  )
  ids.category = category.rows[0].id

  const vendor = await query(
    `INSERT INTO vendors (name, slug, email, phone, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
    [`Visibility Vendor ${suffix}`, `visibility-vendor-${suffix}`, `visibility-${suffix}@example.test`, `97${suffix.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`]
  )
  ids.vendor = vendor.rows[0].id

  const request = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline, offer_total)
     VALUES ($1, $2, 'FIXED_OFFER', 'PUBLISHED', $3, NOW() + interval '3 days', NOW() + interval '1 day', 900)
     RETURNING id`,
    [`PRQ-VIS-${suffix}`, ids.shop, 'Request-supply-visibility test']
  )
  ids.request = request.rows[0].id

  const item = await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit, fixed_unit_price)
     VALUES ($1, $2, 'Chicken', 9, 'KG', 100) RETURNING id`,
    [ids.request, ids.category]
  )
  ids.requestItem = item.rows[0].id

  await query(
    `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility) VALUES ($1, $2, '{}'::jsonb)`,
    [ids.request, ids.vendor]
  )
})

afterAll(async () => {
  if (dbUp) {
    await query(`DELETE FROM procurement_supply_events WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
    await query(`DELETE FROM procurement_supply_order_items WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
    await query(`DELETE FROM procurement_supply_orders WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_recipients WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [ids.request])
    await query(`DELETE FROM procurement_requests WHERE id = $1`, [ids.request])
    await query(`DELETE FROM vendors WHERE id = $1`, [ids.vendor])
    await query(`DELETE FROM categories WHERE id = $1`, [ids.category])
    await query(`DELETE FROM shops WHERE id = $1`, [ids.shop])
    await closePool()
  }
})

describe.skipIf(!dbUp)('getRequest — supply order visibility', () => {
  const service = new VendorProcurementService()

  it('has no supply order before the offer is accepted', async () => {
    const detail = await service.getRequest(ids.request)
    expect(detail.supply_order).toBeNull()
  })

  it('surfaces the real, live supply order once accepted, and tracks its status forward', async () => {
    const accepted = await service.acceptFixedOffer(ids.request, ids.vendor, null)
    ids.supply = accepted.supply_order.id

    let detail = await service.getRequest(ids.request)
    expect(detail.supply_order).not.toBeNull()
    expect(detail.supply_order.id).toBe(ids.supply)
    expect(detail.supply_order.status).toBe('AWARDED')
    expect(detail.supply_order.items).toHaveLength(1)
    expect(detail.supply_order.events.length).toBeGreaterThan(0)

    await service.updateSupplyStatus(ids.supply, ids.vendor, null, 'ACCEPTED')
    await service.updateSupplyStatus(ids.supply, ids.vendor, null, 'PROCESSING')

    detail = await service.getRequest(ids.request)
    expect(detail.supply_order.status).toBe('PROCESSING')
    // Not a stale snapshot — the event timeline grew with the real transitions.
    const statuses = detail.supply_order.events.map((e) => e.to_status)
    expect(statuses).toContain('ACCEPTED')
    expect(statuses).toContain('PROCESSING')
  })

  it('scopes correctly: assertShopAccess still rejects a different shop', async () => {
    await expect(service.getRequest(ids.request, { scopedShopId: 'some-other-shop-id' })).rejects.toMatchObject({
      statusCode: 403,
    })
  })
})
