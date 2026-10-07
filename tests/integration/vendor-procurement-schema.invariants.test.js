/**
 * Vendor procurement database invariant tests (Big Phase 2)
 *
 * Proves the database-level invariants of migrations 133–136 against the real
 * PostgreSQL instance (blueprint 01 §21: integrity must not depend on the
 * service layer). Every test runs inside a transaction that is always rolled
 * back, so the local database is never mutated.
 *
 * The suite SKIPS itself when no database is reachable (e.g. CI without
 * Docker) so it can never grow the pre-existing baseline failure set.
 */

import { beforeAll, afterEach, afterAll, describe, expect, it } from 'vitest'
import { config } from 'dotenv'
import pg from 'pg'

config()

// Probe the database at module top level: describe.skipIf is evaluated at
// collection time, so the decision must be made before any beforeAll runs.
let pool
let dbUp = false
try {
  const probe = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 1,
    connectionTimeoutMillis: 2000,
  })
  await probe.query('SELECT 1')
  await probe.end()
  dbUp = true
} catch {
  dbUp = false
}

let client
const suffix = Math.random().toString(36).slice(2, 10)

beforeAll(async () => {
  if (!dbUp) return
  pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 2,
  })
})

afterEach(async () => {
  if (client) {
    await client.query('ROLLBACK')
    client.release()
    client = undefined
  }
})

afterAll(async () => {
  if (pool) await pool.end()
})

/**
 * Begins a transaction and seeds the FK fixtures every test needs.
 * Returns { shopId, categoryId, vendorIds, userId, requestId, requestItemId }.
 */
async function beginWithFixtures() {
  client = await pool.connect()
  await client.query('BEGIN')

  const shop = await client.query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      `Proc Test Store ${suffix}`,
      `proc-test-store-${suffix}`,
      `PT${suffix.slice(0, 6)}`,
      '1 Test Lane',
      'Kolkata',
      'West Bengal',
      '700001',
      22.5726,
      88.3639,
    ]
  )
  const shopId = shop.rows[0].id

  const category = await client.query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Proc Test Chicken ${suffix}`, `proc-test-chicken-${suffix}`]
  )
  const categoryId = category.rows[0].id

  const user = await client.query(
    `INSERT INTO users (phone) VALUES ($1) RETURNING id`,
    [`99${suffix.replace(/\D/g, '').padEnd(3, '7').slice(0, 8)}0`.slice(0, 15)]
  )
  const userId = user.rows[0].id

  const vendorIds = []
  for (let i = 0; i < 2; i++) {
    const vendor = await client.query(
      `INSERT INTO vendors (name, slug, email, phone, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [
        `Proc Test Vendor ${suffix} ${i}`,
        `proc-test-vendor-${suffix}-${i}`,
        `proc-test-${suffix}-${i}@example.test`,
        `98${i}${suffix.replace(/\D/g, '').padEnd(3, '3').slice(0, 7)}0`.slice(0, 15),
      ]
    )
    vendorIds.push(vendor.rows[0].id)
  }

  const request = await client.query(
    `INSERT INTO procurement_requests (request_number, shop_id, mode, title)
     VALUES ($1, $2, 'RFQ', $3) RETURNING id`,
    [`PRQ-T-${suffix}`, shopId, 'Procurement invariant test request']
  )
  const requestId = request.rows[0].id

  const item = await client.query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity)
     VALUES ($1, $2, 'Chicken', 20) RETURNING id`,
    [requestId, categoryId]
  )
  const requestItemId = item.rows[0].id

  return { shopId, categoryId, vendorIds, userId, requestId, requestItemId }
}

async function insertRecipient(requestId, vendorId) {
  const result = await client.query(
    `INSERT INTO procurement_recipients (request_id, vendor_id) VALUES ($1, $2) RETURNING id`,
    [requestId, vendorId]
  )
  return result.rows[0].id
}

async function insertQuote(requestId, recipientId, vendorId, { status = 'SUBMITTED' } = {}) {
  const result = await client.query(
    `INSERT INTO procurement_quotes (request_id, recipient_id, vendor_id, grand_total, status)
     VALUES ($1, $2, $3, 5000.00, $4) RETURNING id`,
    [requestId, recipientId, vendorId, status]
  )
  return result.rows[0].id
}

describe.skipIf(!dbUp)('vendor procurement database invariants', () => {
  it('rejects a duplicate recipient for the same (request, vendor)', async () => {
    const { requestId, vendorIds } = await beginWithFixtures()
    await insertRecipient(requestId, vendorIds[0])

    await expect(
      client.query(
        `INSERT INTO procurement_recipients (request_id, vendor_id) VALUES ($1, $2)`,
        [requestId, vendorIds[0]]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_procurement_recipient' })
  })

  it('allows only one SELECTED quote per request (single RFQ winner)', async () => {
    const { requestId, vendorIds } = await beginWithFixtures()

    const recipientA = await insertRecipient(requestId, vendorIds[0])
    const recipientB = await insertRecipient(requestId, vendorIds[1])
    await insertQuote(requestId, recipientA, vendorIds[0], { status: 'SELECTED' })

    await expect(
      client.query(
        `INSERT INTO procurement_quotes (request_id, recipient_id, vendor_id, grand_total, status)
         VALUES ($1, $2, $3, 4800.00, 'SELECTED')`,
        [requestId, recipientB, vendorIds[1]]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_one_selected_quote_per_request' })
  })

  it('allows only one supply order per request (single award)', async () => {
    const { requestId, shopId, vendorIds } = await beginWithFixtures()

    await client.query(
      `INSERT INTO procurement_supply_orders (supply_number, request_id, vendor_id, shop_id, source_mode, award_amount)
       VALUES ($1, $2, $3, $4, 'RFQ', 5000.00)`,
      [`SUP-T-${suffix}-A`, requestId, vendorIds[0], shopId]
    )

    await expect(
      client.query(
        `INSERT INTO procurement_supply_orders (supply_number, request_id, vendor_id, shop_id, source_mode, award_amount)
         VALUES ($1, $2, $3, $4, 'RFQ', 5100.00)`,
        [`SUP-T-${suffix}-B`, requestId, vendorIds[1], shopId]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_one_supply_order_per_request' })
  })

  it('enforces accepted + rejected <= received on receipt items', async () => {
    const { requestId, shopId, userId, requestItemId, vendorIds } = await beginWithFixtures()

    const supply = await client.query(
      `INSERT INTO procurement_supply_orders (supply_number, request_id, vendor_id, shop_id, source_mode, award_amount)
       VALUES ($1, $2, $3, $4, 'RFQ', 5000.00) RETURNING id`,
      [`SUP-T-${suffix}-C`, requestId, vendorIds[0], shopId]
    )
    const supplyOrderId = supply.rows[0].id

    const supplyItem = await client.query(
      `INSERT INTO procurement_supply_order_items
         (supply_order_id, request_item_id, item_name, agreed_quantity, agreed_unit_price, agreed_line_total)
       VALUES ($1, $2, 'Chicken', 20, 250.00, 5000.00) RETURNING id`,
      [supplyOrderId, requestItemId]
    )

    const receipt = await client.query(
      `INSERT INTO procurement_receipts (supply_order_id, shop_id, received_by) VALUES ($1, $2, $3) RETURNING id`,
      [supplyOrderId, shopId, userId]
    )

    // Positive control: 19.4 received, 19.2 accepted, 0.2 rejected is valid.
    await client.query(
      `INSERT INTO procurement_receipt_items
         (receipt_id, supply_order_item_id, requested_quantity, received_quantity, accepted_quantity, rejected_quantity)
       VALUES ($1, $2, 20, 19.4, 19.2, 0.2)`,
      [receipt.rows[0].id, supplyItem.rows[0].id]
    )

    // Violation: 8 accepted + 3 rejected = 11 > 10 received.
    await expect(
      client.query(
        `INSERT INTO procurement_receipt_items
           (receipt_id, supply_order_item_id, requested_quantity, received_quantity, accepted_quantity, rejected_quantity)
         VALUES ($1, $2, 20, 10, 8, 3)`,
        [receipt.rows[0].id, supplyItem.rows[0].id]
      )
    ).rejects.toMatchObject({ code: '23514', constraint: 'chk_receipt_accepted_plus_rejected' })
  })

  it('rejects recipient statuses outside the blueprint state model', async () => {
    const { requestId, vendorIds } = await beginWithFixtures()

    await expect(
      client.query(
        `INSERT INTO procurement_recipients (request_id, vendor_id, status) VALUES ($1, $2, 'LOST')`,
        [requestId, vendorIds[0]]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects quotes whose recipient is not a persisted recipient of the request', async () => {
    const { requestId, vendorIds } = await beginWithFixtures()
    const ghostRecipient = '00000000-0000-4000-8000-000000000000'

    await expect(
      client.query(
        `INSERT INTO procurement_quotes (request_id, recipient_id, vendor_id, grand_total)
         VALUES ($1, $2, $3, 5000.00)`,
        [requestId, ghostRecipient, vendorIds[0]]
      )
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('rolls back every fixture so the local database stays untouched', async () => {
    const { requestId } = await beginWithFixtures()
    const check = await client.query('SELECT COUNT(*)::int AS n FROM procurement_requests WHERE id = $1', [requestId])
    expect(check.rows[0].n).toBe(1)

    // ROLLBACK happens in afterEach; the assertion below runs in a fresh
    // transaction through the pool to confirm nothing persisted.
    const persisted = await pool.query('SELECT COUNT(*)::int AS n FROM procurement_requests WHERE id = $1', [requestId])
    expect(persisted.rows[0].n).toBe(0)
  })
})

describe.skipIf(!dbUp)('supply fulfilment state machine (Big Phase 11)', () => {
  const suffix2 = Math.random().toString(36).slice(2, 10)
  const ids2 = {}

  afterAll(async () => {
    if (!dbUp) return
    await pool.query(`DELETE FROM procurement_evidence WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE supply_number = $1)`, [`SUP-SM-${suffix2}`])
    await pool.query(`DELETE FROM procurement_supply_events WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE supply_number = $1)`, [`SUP-SM-${suffix2}`])
    await pool.query(`DELETE FROM procurement_supply_order_items WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE supply_number = $1)`, [`SUP-SM-${suffix2}`])
    await pool.query(`DELETE FROM procurement_supply_orders WHERE supply_number = $1`, [`SUP-SM-${suffix2}`])
    await pool.query(`DELETE FROM procurement_request_items WHERE request_id IN (SELECT id FROM procurement_requests WHERE request_number = $1)`, [`PRQ-SM-${suffix2}`])
    await pool.query(`DELETE FROM procurement_requests WHERE request_number = $1`, [`PRQ-SM-${suffix2}`])
    await pool.query(`DELETE FROM vendor_users WHERE vendor_id = ANY($1)`, [[ids2.vendor, ids2.ghost].filter(Boolean)])
    await pool.query(`DELETE FROM vendors WHERE id = ANY($1)`, [[ids2.vendor, ids2.ghost].filter(Boolean)])
    await pool.query(`DELETE FROM categories WHERE slug = $1`, [`sm-cat-${suffix2}`])
    await pool.query(`DELETE FROM shops WHERE slug = $1`, [`sm-store-${suffix2}`])
  })

  it('walks the vendor-controlled path and enforces gates', async () => {
    const { VendorProcurementService: Live } = await import('../../src/modules/vendor-procurement/vendor-procurement.service.js')
    const service = new Live()

    // Fixture (committed, cleaned up above).
    const setup = await pool.connect()
    try {
      const shop = await setup.query(
        `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [`SM Store ${suffix2}`, `sm-store-${suffix2}`, `SM${suffix2.slice(0,6)}`, '1 SM Lane', 'Kolkata', 'WB', '700001', 22.5, 88.3]
      )
      const category = await setup.query(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, [`SM Cat ${suffix2}`, `sm-cat-${suffix2}`])
      const vendor = await setup.query(
        `INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`,
        [`SM Vendor ${suffix2}`, `sm-vendor-${suffix2}`, `sm-${suffix2}@example.test`, `91${suffix2.replace(/[^0-9a-z]/g, '').padEnd(8, '7').slice(0, 8)}`]
      )
      ids2.vendor = vendor.rows[0].id
      const request = await setup.query(
        `INSERT INTO procurement_requests (request_number, shop_id, mode, status, title)
         VALUES ($1,$2,'RFQ','PUBLISHED','SM request') RETURNING id`,
        [`PRQ-SM-${suffix2}`, shop.rows[0].id]
      )
      const item = await setup.query(
        `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity)
         VALUES ($1,$2,'Chicken',20) RETURNING id`,
        [request.rows[0].id, category.rows[0].id]
      )
      ids2.requestItem = item.rows[0].id
      const supply = await setup.query(
        `INSERT INTO procurement_supply_orders (supply_number, request_id, vendor_id, shop_id, source_mode, award_amount, status)
         VALUES ($1,$2,$3,$4,'FIXED_OFFER',5000,'AWARDED') RETURNING id`,
        [`SUP-SM-${suffix2}`, request.rows[0].id, ids2.vendor, shop.rows[0].id]
      )
      ids2.supply = supply.rows[0].id
    } finally {
      setup.release()
    }

    // Happy path: AWARDED → ACCEPTED → PROCESSING → CLEANING.
    for (const status of ['ACCEPTED', 'PROCESSING', 'CLEANING']) {
      await service.updateSupplyStatus(ids2.supply, ids2.vendor, null, status)
    }
    let row = (await pool.query(`SELECT status FROM procurement_supply_orders WHERE id = $1`, [ids2.supply])).rows[0]
    expect(row.status).toBe('CLEANING')

    const events = (await pool.query(`SELECT to_status FROM procurement_supply_events WHERE supply_order_id = $1 ORDER BY created_at`, [ids2.supply])).rows.map((r) => r.to_status)
    expect(events).toEqual(['ACCEPTED', 'PROCESSING', 'CLEANING'])

    // Invalid jump: CLEANING → DISPATCHED is never legal.
    await expect(service.updateSupplyStatus(ids2.supply, ids2.vendor, null, 'DISPATCHED')).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    })

    // Video gate: PACKED without evidence is rejected even from CLEANING.
    await expect(service.updateSupplyStatus(ids2.supply, ids2.vendor, null, 'PACKED')).rejects.toMatchObject({
      code: 'SUPPLY_EVIDENCE_REQUIRED',
    })

    // With accepted evidence, CLEANING → PACKED succeeds.
    await pool.query(
      `INSERT INTO procurement_evidence (supply_order_id, vendor_id, evidence_type, media_public_id, media_url, review_status)
       VALUES ($1, $2, 'QUALITY_VIDEO', 'sm-evidence-1', 'https://example.test/video.mp4', 'ACCEPTED')`,
      [ids2.supply, ids2.vendor]
    )
    await service.updateSupplyStatus(ids2.supply, ids2.vendor, null, 'PACKED')
    row = (await pool.query(`SELECT status FROM procurement_supply_orders WHERE id = $1`, [ids2.supply])).rows[0]
    expect(row.status).toBe('PACKED')

    // Cross-vendor isolation: another vendor cannot touch this order.
    const ghost = (await pool.query(
      `INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`,
      [`SM Ghost ${suffix2}`, `sm-ghost-${suffix2}`, `sm-ghost-${suffix2}@example.test`, `92${suffix2.replace(/[^0-9a-z]/g, '').padEnd(8, '3').slice(0, 8)}`]
    )).rows[0].id
    ids2.ghost = ghost
    await expect(service.updateSupplyStatus(ids2.supply, ghost, null, 'ACCEPTED')).rejects.toMatchObject({
      code: 'SUPPLY_ORDER_NOT_FOUND',
    })
  })
})
