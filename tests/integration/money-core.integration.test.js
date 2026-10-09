/**
 * Money core — real Postgres: commission rules + vendor wallet ledger.
 *
 *   MONEY_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=money_scratch \
 *   DB_USER=… DB_PASSWORD=… npx vitest run tests/integration/money-core.integration.test.js
 * The target database must already be fully migrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.MONEY_TEST_DB ? describe : describe.skip

d('money core (real database)', () => {
  let q, commission, wallet
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test',
      CORS_ORIGINS: 'http://localhost:3000',
    })
    q = (await import('../../src/config/database.js')).query
    const { CommissionService } = await import('../../src/modules/commission/commission.service.js')
    const { VendorWalletService } = await import('../../src/modules/vendor-wallet/vendor-wallet.service.js')
    commission = new CommissionService()
    wallet = new VendorWalletService()
    F.vendor = (await q(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Money V',$1,$2,$3) RETURNING id`,
      ['mv-' + rand(), `m${rand()}@t.io`, '71' + rand()])).rows[0]
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Fin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.cat = (await q(`INSERT INTO categories (name, slug) VALUES ('Phones-${rand()}',$1) RETURNING id`, ['ph-' + rand()])).rows[0]
  })

  afterAll(async () => {
    await q(`DELETE FROM commission_rules WHERE vendor_id = $1 OR category_id = $2`, [F.vendor.id, F.cat.id])
    await q(`DELETE FROM settlement_ledger WHERE vendor_id = $1`, [F.vendor.id])
  })

  it('creates a vendor rule, rejects a duplicate, and previews the fee chain', async () => {
    const rule = await commission.create({
      scope: 'VENDOR', vendorId: F.vendor.id, channel: 'B2C', commissionPct: 5, platformChargePct: 1, taxPct: 18,
    }, F.admin.id)
    expect(Number(rule.commission_pct)).toBe(5)
    await expect(commission.create({ scope: 'VENDOR', vendorId: F.vendor.id, channel: 'B2C', commissionPct: 6 }, F.admin.id))
      .rejects.toMatchObject({ code: 'DUPLICATE_RULE' })
    const p = await commission.preview({ vendorId: F.vendor.id, channel: 'B2C', items: [{ lineTotal: 50000 }] })
    expect(p.commission).toBe(2500)
    expect(p.platformCharge).toBe(500)
    expect(p.tax).toBe(540)
    expect(p.vendorNet).toBe(46460)
  })

  it('B2B has no rule yet, so the vendor B2C rule does not apply', async () => {
    const p = await commission.preview({ vendorId: F.vendor.id, channel: 'B2B', items: [{ lineTotal: 1000 }] })
    expect(p.commission).toBe(0)
  })

  it('rejects out-of-range percentages and missing targets', async () => {
    await expect(commission.create({ scope: 'GLOBAL', commissionPct: 120 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(commission.create({ scope: 'CATEGORY', commissionPct: 5 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('wallet: manual entry needs a written reason and a valid reason code', async () => {
    await expect(wallet.addManualEntry(F.vendor.id, { direction: 'CREDIT', reasonCode: 'BONUS', reason: '', amount: 100 }, F.admin.id))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expect(wallet.addManualEntry(F.vendor.id, { direction: 'CREDIT', reasonCode: 'PENALTY', reason: 'wrong side', amount: 100 }, F.admin.id))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('wallet: credit then debit keeps balance_before/after consistent and blocks overdraw', async () => {
    const c = await wallet.addManualEntry(F.vendor.id, { direction: 'CREDIT', reasonCode: 'BONUS', reason: 'Festival bonus', amount: 1000 }, F.admin.id)
    expect(c.balanceBefore).toBe(0)
    expect(c.balanceAfter).toBe(1000)
    const dbt = await wallet.addManualEntry(F.vendor.id, { direction: 'DEBIT', reasonCode: 'PENALTY', reason: 'Late dispatch penalty', amount: 250 }, F.admin.id)
    expect(dbt.balanceBefore).toBe(1000)
    expect(dbt.balanceAfter).toBe(750)
    await expect(wallet.addManualEntry(F.vendor.id, { direction: 'DEBIT', reasonCode: 'PENALTY', reason: 'too much', amount: 5000 }, F.admin.id))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })

    const tx = await wallet.transactions(F.vendor.id, {})
    expect(tx.vendor.balance).toBe(750)
    expect(tx.data[0]).toMatchObject({ type: 'DEBIT', reason_code: 'PENALTY', reason: 'Late dispatch penalty', balance_before: 1000, balance_after: 750 })
    expect(tx.data[1]).toMatchObject({ type: 'CREDIT', reason_code: 'BONUS' })
    const credits = await wallet.transactions(F.vendor.id, { direction: 'CREDIT' })
    expect(credits.data.every((r) => r.type === 'CREDIT')).toBe(true)
  })

  it('ledger trigger fills balance_before and reason_code for writers that do not know about them', async () => {
    await q(`INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, idempotency_key)
             VALUES ($1,'COMMISSION',-50,700,$2)`, [F.vendor.id, 'test:' + rand()])
    const { rows } = await q(`SELECT balance_before, reason_code FROM settlement_ledger WHERE vendor_id = $1 AND entry_type = 'COMMISSION'`, [F.vendor.id])
    expect(Number(rows[0].balance_before)).toBe(750)
    expect(rows[0].reason_code).toBe('PLATFORM_COMMISSION')
  })
})
