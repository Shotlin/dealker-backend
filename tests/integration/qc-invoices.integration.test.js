/**
 * Product QC + invoices — real Postgres.
 *
 *   QC_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   PRIVATE_UPLOAD_DIR=/tmp/qc-private npx vitest run tests/integration/qc-invoices.integration.test.js
 * The target database must already be fully migrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.QC_TEST_DB ? describe : describe.skip

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])

d('QC + invoices (real database)', () => {
  let q, listings, qc, invoices
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const photos = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']
  const form = (o = {}) => ({ invoiceNumber: 'INV-' + rand(), invoiceDate: '2026-09-01', purchaseAmount: '42000', gstAmount: '6407', ...o })
  const file = (buffer = PDF, filename = 'inv.pdf') => ({ buffer, filename })

  async function newListing(over = {}) {
    return listings.create({
      name: 'Test Phone ' + rand(), categoryId: F.cat.id, condition: 'NEW', price: 40000, mrp: 45000, stock: 5,
      images: photos, ownerVendorId: F.vendor.id, warrantyInfo: '1 year', serialNumber: 'SN' + rand(),
      imei: '490154203237518', ...over,
    }, { vendorId: null, actorId: F.admin.id })
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
    })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const { QcService } = await import('../../src/modules/qc/qc.service.js')
    const { InvoicesService } = await import('../../src/modules/invoices/invoices.service.js')
    qc = new QcService()
    invoices = new InvoicesService({ qc })
    const one = async (sql, p) => (await q(sql, p)).rows[0]
    F.admin = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'QC Admin','ADMIN') RETURNING id`, ['8' + rand()])
    F.vendor = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('QC Vendor',$1,$2,$3,'ACTIVE') RETURNING id`,
      ['qcv-' + rand(), `q${rand()}@t.io`, '73' + rand()])
    await one(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ('QC Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,5,true) RETURNING id`,
      ['qcs-' + rand(), 'Q' + rand().slice(0, 6), F.vendor.id])
    F.cat = await one(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, ['Smartphones ' + rand(), 'sp-' + rand()])
    await q(`UPDATE qc_rules SET params = jsonb_set(params, '{categoryKeywords}', '["smartphones"]') WHERE key = 'IMEI'`)
  })

  afterAll(async () => {
    await q(`UPDATE qc_settings SET require_pass_to_publish = FALSE, auto_qc_enabled = TRUE WHERE id = 1`)
  })

  it('a new listing starts QC_PENDING or is auto-checked, and the invoice rule fails without an invoice', async () => {
    const l = await newListing()
    const det = await qc.detail(l.id)
    const inv = det.live.results.find((r) => r.key === 'INVOICE')
    expect(inv.status).toBe('FAIL')
    expect(det.live.status).toBe('QC_RECHECK') // required rules pass, invoice/doc rules fail → below threshold
  })

  it('upload → verify makes QC pass automatically, and the invoice maps to the listing', async () => {
    const l = await newListing()
    const inv = await invoices.create(l.id, form({ invoiceNumber: 'INV-A-' + rand() }), file(), { actorId: F.admin.id })
    expect(inv.status).toBe('UPLOADED')
    expect(inv.invoice_date).toBe('2026-09-01') // no timezone drift
    expect(inv.product_name).toBe(l.name)
    expect(inv.imei_serial).toBe('490154203237518') // mapped from the listing
    expect(inv.vendor_id).toBe(F.vendor.id)
    const verified = await invoices.verify(inv.id, F.admin.id)
    expect(verified.status).toBe('VERIFIED')
    const after = await qc.detail(l.id)
    expect(after.qc_status).toBe('QC_PASSED')
    expect(after.qc_mode).toBe('AUTO')
    expect((await q(`SELECT has_invoice FROM products WHERE id = $1`, [l.product_id])).rows[0].has_invoice).toBe(true)
  })

  it('a verified invoice is permanent: no delete, no reject, DB trigger blocks edits', async () => {
    const l = await newListing()
    const inv = await invoices.verify((await invoices.create(l.id, form(), file(), { actorId: F.admin.id })).id, F.admin.id)
    await expect(invoices.remove(inv.id)).rejects.toMatchObject({ code: 'PERMANENT' })
    await expect(invoices.reject(inv.id, 'changed my mind', F.admin.id)).rejects.toMatchObject({ code: 'PERMANENT' })
    await expect(q(`UPDATE listing_invoices SET purchase_amount = 1 WHERE id = $1`, [inv.id])).rejects.toThrow(/permanent/)
    await expect(q(`DELETE FROM listing_invoices WHERE id = $1`, [inv.id])).rejects.toThrow(/permanent/)
  })

  it('reject needs a reason; rejected invoices cannot be verified but can be removed, and a duplicate number is refused', async () => {
    const l = await newListing()
    const num = 'INV-D-' + rand()
    const a = await invoices.create(l.id, form({ invoiceNumber: num }), file(), { actorId: F.admin.id })
    await expect(invoices.create(l.id, form({ invoiceNumber: num }), file(), { actorId: F.admin.id })).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE' })
    await expect(invoices.reject(a.id, 'bad', F.admin.id)).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    const rej = await invoices.reject(a.id, 'Photo is blurry, upload a clear scan', F.admin.id)
    expect(rej.status).toBe('REJECTED')
    await expect(invoices.verify(a.id, F.admin.id)).rejects.toMatchObject({ code: 'REJECTED' })
    // the same number can be uploaded again once the first was rejected
    const again = await invoices.create(l.id, form({ invoiceNumber: num }), file(PNG, 'scan.png'), { actorId: F.admin.id })
    expect(again.mime_type).toBe('image/png')
    await invoices.remove(again.id)
  })

  it('validates fields and file contents; vendors only reach their own listings', async () => {
    const l = await newListing()
    await expect(invoices.create(l.id, form({ invoiceDate: '2999-01-01' }), file(), {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(invoices.create(l.id, form({ purchaseAmount: '0' }), file(), {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(invoices.create(l.id, form({ gstAmount: '999999' }), file(), {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(invoices.create(l.id, form(), { buffer: Buffer.from('MZ not a pdf'), filename: 'evil.pdf' }, {})).rejects.toMatchObject({ code: 'FILE_TYPE' })
    await expect(invoices.create(l.id, form(), null, {})).rejects.toMatchObject({ code: 'FILE_REQUIRED' })
    const other = (await q(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Other',$1,$2,$3) RETURNING id`, ['o-' + rand(), `o${rand()}@t.io`, '74' + rand()])).rows[0]
    await expect(invoices.create(l.id, form(), file(), { vendorId: other.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('manual QC: FAILED needs a note, is recorded in history, and auto runs do not overwrite it', async () => {
    const l = await newListing()
    await expect(qc.setManual(l.id, 'QC_FAILED', '', F.admin.id)).rejects.toMatchObject({ code: 'NOTE_REQUIRED' })
    const failed = await qc.setManual(l.id, 'QC_FAILED', 'Photos do not show the IMEI sticker', F.admin.id)
    expect(failed.qc_status).toBe('QC_FAILED')
    expect(failed.qc_mode).toBe('MANUAL')
    const bg = await qc.runAuto(l.id, null, { force: false })
    expect(bg.skipped).toBe(true)
    expect((await qc.detail(l.id)).qc_status).toBe('QC_FAILED')
    const forced = await qc.runAuto(l.id, F.admin.id) // explicit admin click
    expect(forced.skipped).toBe(false)
    const events = (await qc.detail(l.id)).events
    expect(events.map((e) => e.mode)).toContain('MANUAL')
    expect(events[0].mode).toBe('AUTO')
  })

  it('editing listing content resets QC, and IMEI failures are caught', async () => {
    const l = await newListing({ imei: '490154203237519' }) // bad checksum
    const det = await qc.detail(l.id)
    expect(det.live.status).toBe('QC_FAILED')
    expect(det.live.requiredFailed).toContain('IMEI')
    await listings.update(l.id, { imei: '490154203237518' }, { vendorId: null, actorId: F.admin.id })
    const fixed = await qc.detail(l.id)
    expect(fixed.live.results.find((r) => r.key === 'IMEI').status).toBe('PASS')
  })

  it('approval can require QC to pass', async () => {
    await q(`UPDATE qc_settings SET require_pass_to_publish = TRUE WHERE id = 1`)
    const l = await newListing()
    await expect(listings.approve(l.id, F.admin.id)).rejects.toMatchObject({ code: 'QC_NOT_PASSED' })
    await qc.setManual(l.id, 'QC_PASSED', 'Checked in person', F.admin.id)
    const ok = await listings.approve(l.id, F.admin.id)
    expect(ok.approval_status).toBe('APPROVED')
    await q(`UPDATE qc_settings SET require_pass_to_publish = FALSE WHERE id = 1`)
  })

  it('bulk auto QC and config validation', async () => {
    await newListing()
    const sum = await qc.runAutoBulk(F.admin.id, { statuses: ['QC_PENDING', 'QC_RECHECK', 'QC_FAILED', 'QC_PASSED'], limit: 50 })
    expect(sum.processed).toBeGreaterThan(0)
    expect(sum.errors).toBe(0)
    await expect(qc.updateConfig({ settings: { passThreshold: 0 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(qc.updateConfig({ rules: [{ key: 'NOPE' }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    const cfg = await qc.updateConfig({ rules: [{ key: 'SERIAL_NUMBER', weight: 7 }] })
    expect(cfg.rules.find((r) => r.key === 'SERIAL_NUMBER').weight).toBe(7)
    await qc.updateConfig({ rules: [{ key: 'SERIAL_NUMBER', weight: 5 }] })
  })
})
