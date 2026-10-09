/**
 * Order stage timeline + manual override — real Postgres.
 *
 *   STAGES_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/order-stages.integration.test.js
 */
import { beforeAll, describe, expect, it } from 'vitest'

const d = process.env.STAGES_TEST_DB ? describe : describe.skip

d('order stages (real database)', () => {
  let q, svc, computeStages
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')

  /** An order with `n` seller orders (one vendor each) and one item per seller order. */
  async function mkOrder({ method = 'ONLINE', pay = 'PAID', plan = 'FULL_ONLINE', due = 0, sellers = 1, qc = 'QC_PASSED' } = {}) {
    const total = 1000 * sellers
    const o = (await q(
      `INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, payment_method, payment_status, payment_plan, amount_due, amount_paid, delivery_address)
       VALUES ($1,$2,TRUE,'ORDER_PLACED','[]'::jsonb,$3,$3,$4,$5,$6,$7,$8,'{}'::jsonb) RETURNING id`,
      ['ST-' + rand(), F.customer, total, method, pay, plan, due, pay === 'PAID' ? total : 0])).rows[0]
    const sellerIds = []
    for (let i = 0; i < sellers; i++) {
      const p = (await q(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('Stage Phone',$1,1000,'VENDOR',$2,true) RETURNING id`, ['sp-' + rand(), F.vendor.id])).rows[0]
      const sp = (await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available, qc_status) VALUES ($1,$2,1000,5,true,$3) RETURNING id`, [F.shop.id, p.id, qc])).rows[0]
      const so = (await q(`INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, shop_id, status, item_subtotal, commission_amount, payable_to_seller) VALUES ($1,$2,$3,$4,'ORDER_PLACED',1000,100,900) RETURNING id`,
        [o.id, 'SO-' + rand(), F.vendor.id, F.shop.id])).rows[0]
      await q(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, unit, subtotal, shop_product_id, shop_id, seller_order_id) VALUES ($1,$2,'Stage Phone',1000,1,'pc',1000,$3,$4,$5)`,
        [o.id, p.id, sp.id, F.shop.id, so.id])
      sellerIds.push(so.id)
    }
    return { id: o.id, sellerIds }
  }
  const status = async (id) => (await q('SELECT status, payment_status, amount_paid, amount_due FROM orders WHERE id = $1', [id])).rows[0]
  const sellerStatuses = async (id) => (await q('SELECT status FROM seller_orders WHERE order_id = $1 ORDER BY seller_order_number', [id])).rows.map((r) => r.status)
  const stageMap = (t) => Object.fromEntries(t.stages.map((s) => [s.key, s]))

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    const mod = await import('../../src/modules/order-stages/order-stages.service.js')
    svc = new mod.OrderStagesService(); computeStages = mod.computeStages
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Stage Admin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.customer = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Stage Customer','CUSTOMER') RETURNING id`, ['7' + rand()])).rows[0].id
    F.vendor = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Stage V',$1,$2,$3,'ACTIVE') RETURNING id`, ['sv-' + rand(), `s${rand()}@t.io`, '64' + rand()])).rows[0]
    F.shop = (await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('Stage Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['sh-' + rand(), 'T' + rand().slice(0, 6), F.vendor.id])).rows[0]
  })

  it('a fresh paid order shows nine stages with the right ones done', async () => {
    const o = await mkOrder()
    const t = await svc.get(o.id)
    expect(t.stages.map((s) => s.key)).toEqual(['PLACED', 'PAYMENT', 'VENDOR_CONFIRMATION', 'QC', 'PACKING', 'SHIPPING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'])
    const m = stageMap(t)
    expect([m.PLACED.done, m.PAYMENT.done, m.QC.done]).toEqual([true, true, true])
    expect([m.VENDOR_CONFIRMATION.done, m.PACKING.done, m.DELIVERED.done]).toEqual([false, false, false])
    expect(m.VENDOR_CONFIRMATION.current).toBe(true)
    expect(m.QC.detail).toBe('1 of 1 item QC passed')
  })

  it('an unpaid online order blocks every later stage until payment is marked received', async () => {
    const o = await mkOrder({ pay: 'PENDING' })
    const m = stageMap(await svc.get(o.id))
    expect(m.PAYMENT.done).toBe(false)
    expect(m.PAYMENT.canOverride).toBe(true)
    expect(m.VENDOR_CONFIRMATION.canOverride).toBe(false)
    expect(m.VENDOR_CONFIRMATION.blocked).toMatch(/payment/i)
    await expect(svc.override(o.id, 'VENDOR_CONFIRMATION', 'confirm for the customer', F.admin.id)).rejects.toMatchObject({ code: 'PAYMENT_PENDING' })
    const t = await svc.override(o.id, 'PAYMENT', 'Customer paid by bank transfer, UTR 12345', F.admin.id)
    expect(stageMap(t).PAYMENT.done).toBe(true)
    expect(await status(o.id)).toMatchObject({ payment_status: 'PAID', amount_due: '0.00' })
    await expect(svc.override(o.id, 'VENDOR_CONFIRMATION', 'ok now', F.admin.id)).resolves.toBeTruthy()
  })

  it('a reason is required, unknown stages are refused, and the order cannot move backward', async () => {
    const o = await mkOrder()
    await expect(svc.override(o.id, 'PACKING', '', F.admin.id)).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expect(svc.override(o.id, 'TELEPORT', 'because I can', F.admin.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.override(o.id, 'PLACED', 'already placed', F.admin.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await svc.override(o.id, 'PACKING', 'Packed at the warehouse, seller forgot to update', F.admin.id)
    await expect(svc.override(o.id, 'VENDOR_CONFIRMATION', 'go back', F.admin.id)).rejects.toMatchObject({ code: 'ALREADY_DONE' })
    await expect(svc.get('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('jumping forward moves every seller order through the skipped steps and logs who/why', async () => {
    const o = await mkOrder({ sellers: 2 })
    const t = await svc.override(o.id, 'SHIPPING', 'Courier picked up both parcels today', F.admin.id)
    expect(await sellerStatuses(o.id)).toEqual(['SHIPPED', 'SHIPPED'])
    const m = stageMap(t)
    expect([m.VENDOR_CONFIRMATION.done, m.PACKING.done, m.SHIPPING.done, m.OUT_FOR_DELIVERY.done]).toEqual([true, true, true, false])
    expect(m.SHIPPING.override).toMatchObject({ reason: 'Courier picked up both parcels today', by: 'Stage Admin' })
    expect((await status(o.id)).status).toBe('SHIPPED')
    expect((await q(`SELECT shipped_at FROM seller_orders WHERE order_id = $1`, [o.id])).rows.every((r) => r.shipped_at)).toBe(true)
    const hist = (await q(`SELECT note FROM order_status_history WHERE order_id = $1 ORDER BY changed_at DESC LIMIT 1`, [o.id])).rows[0]
    expect(hist.note).toMatch(/Admin override \(shipping\)/)
    expect(t.history[0]).toMatchObject({ stage: 'SHIPPING', by: 'Stage Admin' })
  })

  it('QC can be waived by an admin (recorded, listings untouched)', async () => {
    const o = await mkOrder({ qc: 'QC_PENDING' })
    expect(stageMap(await svc.get(o.id)).QC.done).toBe(false)
    const t = await svc.override(o.id, 'QC', 'Inspected in person at the hub', F.admin.id)
    expect(stageMap(t).QC).toMatchObject({ done: true, override: { reason: 'Inspected in person at the hub' } })
    expect((await q(`SELECT qc_status FROM shop_products sp JOIN order_items oi ON oi.shop_product_id = sp.id WHERE oi.order_id = $1`, [o.id])).rows[0].qc_status).toBe('QC_PENDING')
  })

  it('Delivered completes COD, runs the delivery side-effects and posts vendor settlement; Completed closes it', async () => {
    const o = await mkOrder({ method: 'COD', pay: 'PENDING', plan: 'COD', due: 1000 })
    expect(stageMap(await svc.get(o.id)).PAYMENT.done).toBe(true)        // cash on delivery counts as settled
    const t = await svc.override(o.id, 'DELIVERED', 'Customer confirmed receipt on the phone', F.admin.id)
    expect(await sellerStatuses(o.id)).toEqual(['DELIVERED'])
    expect(await status(o.id)).toMatchObject({ status: 'DELIVERED', payment_status: 'PAID', amount_due: '0.00' })
    expect(stageMap(t).DELIVERED.done).toBe(true)
    const ledger = (await q(`SELECT entry_type FROM settlement_ledger WHERE seller_order_id = $1`, [o.sellerIds[0]])).rows.map((r) => r.entry_type)
    expect(ledger).toEqual(expect.arrayContaining(['GROSS_SALES', 'COMMISSION']))
    const done = await svc.override(o.id, 'COMPLETED', 'Return window closed', F.admin.id)
    expect((await status(o.id)).status).toBe('COMPLETED')
    expect(await sellerStatuses(o.id)).toEqual(['CLOSED'])
    expect(stageMap(done).COMPLETED.done).toBe(true)
    await expect(svc.override(o.id, 'COMPLETED', 'again', F.admin.id)).rejects.toMatchObject({ code: 'ALREADY_DONE' })
  })

  it('cancelled or refunded orders cannot be overridden; a cancelled seller order is ignored', async () => {
    const o = await mkOrder()
    await q(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [o.id])
    await expect(svc.override(o.id, 'PACKING', 'try anyway', F.admin.id)).rejects.toMatchObject({ code: 'ORDER_CLOSED' })
    const t = await svc.get(o.id)
    expect(t.terminal).toBe(true)
    expect(t.stages.every((s) => !s.canOverride)).toBe(true)

    const two = await mkOrder({ sellers: 2 })
    await q(`UPDATE seller_orders SET status = 'CANCELLED' WHERE id = $1`, [two.sellerIds[1]])
    await svc.override(two.id, 'VENDOR_CONFIRMATION', 'one seller dropped out, rest confirmed', F.admin.id)
    const st = (await q(`SELECT status FROM seller_orders WHERE id = ANY($1::uuid[])`, [two.sellerIds])).rows.map((r) => r.status).sort()
    expect(st).toEqual(['CANCELLED', 'CONFIRMED'])
  })

  it('computeStages is pure: partially paid and QC counts', () => {
    const base = { order: { status: 'CONFIRMED', payment_method: 'ONLINE', payment_plan: 'PARTIAL', payment_status: 'PARTIALLY_PAID' }, sellerOrders: [{ status: 'CONFIRMED' }], overrides: [] }
    const m = stageMap(computeStages({ ...base, qc: { total: 3, passed: 2 } }))
    expect(m.PAYMENT.detail).toBe('Advance paid')
    expect(m.QC.done).toBe(false)
    expect(m.QC.detail).toBe('2 of 3 items QC passed')
    expect(m.VENDOR_CONFIRMATION.done).toBe(true)
  })
})
