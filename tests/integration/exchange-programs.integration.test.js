/**
 * Exchange programs — integration tests against a REAL Postgres.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5555 DB_NAME=dealker_x DB_USER=dealker_user DB_PASSWORD=x \
 *   npx vitest run tests/integration/exchange-programs.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.SELL_TEST_DB ? describe : describe.skip

d('exchange programs (real database)', () => {
  let q, pool, xp, svc
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const qa = { ageMonths: 6, screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 100, powersOn: true }
  const cust = () => ({ kind: 'CUSTOMER', scopeKind: 'EXCHANGE', userId: F.user })

  const mkCategory = async (name, parent = null) =>
    (await q(`INSERT INTO categories (name, slug, parent_id) VALUES ($1,$2,$3) RETURNING id`, [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${rand()}`, parent])).rows[0].id
  const mkProduct = async (name, categoryId, price) =>
    (await q(`INSERT INTO products (name, slug, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`, [name, `p-${rand()}`, price, categoryId])).rows[0].id

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query; pool = db.pool
    xp = await import('../../src/modules/sell-requests/exchange-programs.service.js')
    svc = await import('../../src/modules/sell-requests/sell-requests.service.js')
    F.user = (await q(`INSERT INTO users (phone, name) VALUES ($1,'Exch Buyer') RETURNING id`, [`9${rand()}`])).rows[0].id
    F.audio = await mkCategory('Audio')
    F.headphones = await mkCategory('Headphones Cat', F.audio) // child of Audio
    F.laptops = await mkCategory('Laptops Cat')
    F.pHead = await mkProduct('boAt Rockerz 450', F.headphones, 1499)
    F.pLap = await mkProduct('Some Laptop', F.laptops, 55000)
    await q(`INSERT INTO sell_device_models (name, category, variants, colors, base_price, brand) VALUES
      ('boAt Rockerz 255', 'Headphones', '["Standard"]', '["Black"]', 1000, 'boAt'),
      ('Sony WH-1000XM4', 'Headphones', '["Standard"]', '["Black"]', 12000, 'Sony')
      ON CONFLICT (name) DO NOTHING`)
  })
  afterAll(async () => { await pool.end() })

  it('a product with no programme is not eligible', async () => {
    expect((await xp.forProduct(F.pHead)).eligible).toBe(false)
  })

  it('validates programmes', async () => {
    await expect(xp.createProgram({ name: 'x', deviceTypes: [], categoryIds: [F.audio] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(xp.createProgram({ name: 'x', deviceTypes: ['Nope'], categoryIds: [F.audio] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(xp.createProgram({ name: 'x', deviceTypes: ['Headphones'], categoryIds: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(xp.createProgram({ name: 'x', deviceTypes: ['Headphones'], categoryIds: [F.audio], maxValuePct: 150 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('a programme on a parent category covers its sub-category products, capped at the share of the price', async () => {
    const p = await xp.createProgram({ name: 'Audio exchange', deviceTypes: ['Headphones'], categoryIds: [F.audio], maxValuePct: 50 })
    F.program = p.id
    const info = await xp.forProduct(F.pHead)
    expect(info.eligible).toBe(true)
    expect(info.types.map((t) => t.key)).toEqual(['Headphones'])
    // 50% of ₹1,499 = 749; the Sony would be ₹12,000 so it is capped
    expect(info.types[0].upTo).toBe(750)
    expect(info.maxValue).toBe(750)
    expect((await xp.forProduct(F.pLap)).eligible).toBe(false)
  })

  it('accepts a headphone trade-in with no IMEI and caps the credit', async () => {
    const r = await svc.createRequest(cust(), {
      type: 'EXCHANGE', model: 'Sony WH-1000XM4', variant: 'Standard', color: 'Black', qa,
      exchange: { newProduct: 'boAt Rockerz 450', newProductPrice: 1499, productId: F.pHead },
    })
    expect(r.device.category).toBe('Headphones')
    expect(r.device.imei).toMatch(/^NA-/)
    expect(r.exchange.tradeInValue).toBeLessThanOrEqual(749)
    expect(r.exchange.payable).toBe(1499 - r.exchange.tradeInValue)
  })

  it('rejects an old-device type the product does not accept', async () => {
    await expect(svc.createRequest(cust(), {
      type: 'EXCHANGE', model: 'iPhone 14', variant: '128GB', color: 'White', imei: '356938035643809', qa,
      exchange: { newProduct: 'boAt Rockerz 450', newProductPrice: 1499, productId: F.pHead },
    })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' })
  })

  it('phones still need a valid IMEI', async () => {
    await expect(svc.createRequest(cust(), {
      type: 'EXCHANGE', model: 'iPhone 14', variant: '128GB', color: 'White', imei: '123', qa,
      exchange: { newProduct: 'x', newProductPrice: 50000 },
    })).rejects.toMatchObject({ code: 'INVALID_IMEI' })
  })

  it('inactive programmes stop applying; deleting works', async () => {
    await xp.updateProgram(F.program, { isActive: false })
    expect((await xp.forProduct(F.pHead)).eligible).toBe(false)
    expect(await xp.deleteProgram(F.program)).toEqual({ deleted: true })
  })

  it('creates a new device type that models can use', async () => {
    const label = `Gadget ${rand()}`
    const t = await xp.saveType({ label, icon: 'camera', hasBattery: true })
    expect(t.key).toBe(label)
    await expect(xp.saveType({ label })).rejects.toMatchObject({ code: 'EXISTS' })
    const m = await svc.createModel({ name: `Canon M50 ${rand()}`, category: label, variants: ['Body'], colors: ['Black'], basePrice: 30000 })
    expect(m.category).toBe(label)
    await expect(svc.createModel({ name: `X ${rand()}`, category: 'Spaceship', variants: ['a'], colors: ['b'], basePrice: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
