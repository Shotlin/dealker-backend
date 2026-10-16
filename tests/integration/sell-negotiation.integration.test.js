/**
 * Sell your phone — asking price + per-buyer chat. Real app over HTTP, real Postgres (migration 209 applied).
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5441 DB_NAME=scratch DB_USER=scratch DB_PASSWORD=pw REDIS_PORT=6391 \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… \
 *   npx vitest run tests/integration/sell-negotiation.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip
const S = '/api/v1/sell-requests'
const M = '/api/v1/manage/sell-requests'

d('sell negotiation', () => {
  let app, q, tmp
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  let seq = 0
  const imei = () => {
    const body = String(35000000000000 + (Date.now() % 1e7) * 10 + seq++).slice(0, 14)
    for (let c = 0; c < 10; c++) {
      const s = body + c
      let sum = 0
      for (let i = 0; i < 15; i++) { let n = Number(s[14 - i]); if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n }
      if (sum % 10 === 0) return s
    }
  }
  const call = async (method, url, who, payload) => {
    const res = await app.inject({ method, url, headers: who ? { authorization: `Bearer ${who.token}` } : {}, payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data }
  }
  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkVendor = async (key) => {
    const n = rand()
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Buyer ${key} ${n}`, `sn-${n}`, `n${n}@x.test`, `7${n}`])
    T[key] = await mkToken('CUSTOMER', `Owner ${key}`)
    T[key].vendorId = v.rows[0].id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T[key].vendorId, T[key].id])
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, is_active)
             VALUES ($1,$2,$3,'1 Main Rd','Kolkata','WB','700001',22.58,88.37,$4,TRUE)`, [`Store ${key}`, `sn-st-${n}`, `N${n.slice(0, 8)}`, T[key].vendorId])
  }
  const qa = { ageMonths: 12, screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 90, powersOn: true }
  const body = (extra = {}) => ({ type: 'SELL_TO_AB', model: 'iPhone 14', variant: '128GB', color: 'White', imei: imei(), qa, location: { lat: 22.5726, lng: 88.3639, pincode: '700001' }, ...extra })
  async function listed(extra = {}) {
    const i = imei()
    const chk = await call('POST', `${S}/verify-imei`, T.cust, { imei: i })
    return call('POST', S, T.cust, body({ imei: i, imeiCheckId: chk.data.checkId, ...extra }))
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-neg-'))
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000', PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'), SELL_DEMO_SEED: '1' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await q(`UPDATE sell_settings SET enabled = TRUE, offer_window_minutes = 60, max_offer_refreshes = 2 WHERE id = TRUE`)
    T.cust = await mkToken('CUSTOMER', 'Rahul Sharma')
    T.other = await mkToken('CUSTOMER', 'Someone Else')
    await mkVendor('buyA')
    await mkVendor('buyB')
  }, 90000)
  afterAll(async () => { await app?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  describe('asking price', () => {
    it('keeps the customer’s own price (the system value is only a suggestion)', async () => {
      const est = await call('POST', `${S}/estimate`, T.cust, body())
      expect(est.status).toBe(200)
      const mine = Math.round(est.data.quote * 1.15)
      const r = await listed({ expectedPrice: mine })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.data.expectedPrice).toBe(mine)
      const list = await call('GET', `${S}/mine`, T.cust)
      const row = list.data.items.find((x) => x.id === r.data.id)
      expect(row.askingPrice).toBe(mine)
      expect(row.offerCount).toBe(0)
      expect(row).toHaveProperty('imageUrl')
    })
    it('refuses nonsense prices', async () => {
      const high = await listed({ expectedPrice: 99999999 })
      expect(high.status).toBe(422)
      expect(high.body.code).toBe('ASKING_PRICE_TOO_HIGH')
      expect((await listed({ expectedPrice: 5 })).status).toBe(422)
    })
    it('falls back to the system value when no price is sent', async () => {
      const r = await listed()
      expect(r.status).toBe(201)
      expect(r.data.expectedPrice).toBe(r.data.quote)
    })
  })

  describe('chat', () => {
    let id
    beforeAll(async () => {
      const r = await listed()
      id = r.data.id
      expect((await call('POST', `${M}/${id}/offers`, T.buyA, { amount: 30000 })).status).toBe(200)
    })
    it('lists only buyers that offered or wrote, and starts empty', async () => {
      const t = await call('GET', `${S}/${id}/threads`, T.cust)
      expect(t.status).toBe(200)
      expect(t.data.threads).toHaveLength(1)
      expect(t.data.threads[0]).toMatchObject({ vendorId: T.buyA.vendorId, offerAmount: 30000, unread: 0, canReply: true })
    })
    it('vendor writes first, customer sees it unread, then replies', async () => {
      const send = await call('POST', `${M}/${id}/messages`, T.buyA, { body: 'Is the phone still under warranty?' })
      expect(send.status, JSON.stringify(send.body)).toBe(200)
      expect(send.data.messages).toHaveLength(1)
      expect(send.data.messages[0].from).toBe('ME')
      let t = await call('GET', `${S}/${id}/threads`, T.cust)
      expect(t.data.unread).toBe(1)
      const th = await call('GET', `${S}/${id}/threads/${T.buyA.vendorId}`, T.cust)
      expect(th.data.messages[0]).toMatchObject({ from: 'OTHER', body: 'Is the phone still under warranty?' })
      expect(th.data.offer.amount).toBe(30000)
      t = await call('GET', `${S}/${id}/threads`, T.cust)
      expect(t.data.unread).toBe(0)
      const rep = await call('POST', `${S}/${id}/threads/${T.buyA.vendorId}/messages`, T.cust, { body: 'Yes, 4 months left.' })
      expect(rep.status).toBe(200)
      expect(rep.data.messages.map((m) => m.from)).toEqual(['OTHER', 'ME'])
      const v = await call('GET', `${M}/${id}/messages`, T.buyA)
      expect(v.data.messages.map((m) => m.from)).toEqual(['ME', 'OTHER'])
    })
    it('blocks phone numbers before acceptance and empty messages', async () => {
      const num = await call('POST', `${S}/${id}/threads/${T.buyA.vendorId}/messages`, T.cust, { body: 'call me 98765 43210 now' })
      expect(num.status).toBe(422)
      expect(num.body.code).toBe('NO_CONTACT_DETAILS')
      expect((await call('POST', `${M}/${id}/messages`, T.buyA, { body: '   ' })).status).toBe(422)
    })
    it('keeps other customers and unrelated buyers out', async () => {
      expect((await call('GET', `${S}/${id}/threads`, T.other)).status).toBe(404)
      expect((await call('GET', `${S}/${id}/threads/${T.buyB.vendorId}`, T.cust)).status).toBe(404)
      expect((await call('POST', `${S}/${id}/threads/${T.buyB.vendorId}/messages`, T.cust, { body: 'hi' })).status).toBe(404)
    })
    it('a second buyer can start a thread without an offer', async () => {
      expect((await call('POST', `${M}/${id}/messages`, T.buyB, { body: 'Can you share more photos?' })).status).toBe(200)
      const t = await call('GET', `${S}/${id}/threads`, T.cust)
      expect(t.data.threads.map((x) => x.vendorId).sort()).toEqual([T.buyA.vendorId, T.buyB.vendorId].sort())
    })
    it('closes the other buyers’ threads once an offer is accepted', async () => {
      await call('POST', `${M}/${id}/offers`, T.buyB, { amount: 31000 })
      const offers = (await call('GET', `${S}/${id}/offers`, T.cust)).data.offers
      const best = offers.find((o) => o.vendorId === T.buyB.vendorId)
      expect((await call('POST', `${S}/${id}/offers/${best.id}/accept`, T.cust)).status).toBe(200)
      const losing = await call('POST', `${S}/${id}/threads/${T.buyA.vendorId}/messages`, T.cust, { body: 'sorry' })
      expect(losing.status).toBe(409)
      expect(losing.body.code).toBe('THREAD_CLOSED')
      expect((await call('POST', `${M}/${id}/messages`, T.buyA, { body: 'still there?' })).status).toBe(409)
      // the winner may now share contact details
      const win = await call('POST', `${S}/${id}/threads/${T.buyB.vendorId}/messages`, T.cust, { body: 'My number is 9876543210' })
      expect(win.status, JSON.stringify(win.body)).toBe(200)
    })
  })

  describe('landing artwork', () => {
    it('serves admin-set banner and step icons in the journey config', async () => {
      await q(`UPDATE sell_settings SET hub_banner_url = 'https://x.test/b.png', hub_step_icons = '["https://x.test/1.png","https://x.test/2.png","https://x.test/3.png"]'::jsonb WHERE id = TRUE`)
      const c = await call('GET', `${S}/journey-config`, T.cust)
      expect(c.data.hubBannerUrl).toBe('https://x.test/b.png')
      expect(c.data.hubStepIcons).toHaveLength(3)
      await q(`UPDATE sell_settings SET hub_banner_url = NULL, hub_step_icons = '[]'::jsonb WHERE id = TRUE`)
    })
  })
})
