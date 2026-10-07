/**
 * Shared helpers for the sponsored-ads module: typed errors, settings, signed impression
 * tokens, transactions, audit events and the ad-wallet ledger.
 *
 * @module modules/ads/ads.shared
 */

import crypto from 'node:crypto'
import { query, getClient } from '../../config/database.js'
import { env } from '../../config/env.js'
import { toPaise, fromPaise } from './ads-engine.js'

export class AdsError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message)
    this.name = 'AdsError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

// ── Settings ────────────────────────────────────────────────────────────

const SETTINGS_TTL_MS = 5000
let settingsCache = { at: 0, value: null }
export const invalidateSettingsCache = () => { settingsCache = { at: 0, value: null } }

export async function getSettings(client = null) {
  if (!client && settingsCache.value && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value
  const run = client ? client.query.bind(client) : query
  const { rows } = await run('SELECT * FROM ad_settings WHERE id = TRUE')
  if (!rows[0]) throw new AdsError('SETTINGS_MISSING', 'Ad settings are not initialised', 500)
  if (!client) settingsCache = { at: Date.now(), value: rows[0] }
  return rows[0]
}

// ── Transactions ────────────────────────────────────────────────────────

export async function withTx(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ── Signed impression tokens ────────────────────────────────────────────
// A token is minted per served ad and binds the price the shopper was *shown*
// (campaign, product, CPC, keyword, user, expiry). The click endpoint trusts nothing
// else from the client, so the price cannot be tampered with and the same impression
// cannot be billed twice (nonce is UNIQUE in ad_clicks).

const tokenKey = () => crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update('dealker:ads:impression:v1').digest()
const b64u = (buf) => Buffer.from(buf).toString('base64url')

export function signImpression(payload) {
  const body = b64u(JSON.stringify(payload))
  const sig = b64u(crypto.createHmac('sha256', tokenKey()).update(body).digest())
  return `${body}.${sig}`
}

/** @returns {object|null} payload, or null when malformed / forged / expired */
export function verifyImpression(token) {
  if (typeof token !== 'string' || token.length > 2000) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', tokenKey()).update(body).digest()
  let given
  try { given = Buffer.from(sig, 'base64url') } catch { return null }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!p || typeof p.e !== 'number' || p.e < Date.now()) return null
    return p
  } catch { return null }
}

export const newNonce = () => crypto.randomBytes(12).toString('hex')

// ── Audit events ────────────────────────────────────────────────────────

export async function logEvent(runner, { campaignId = null, vendorId = null, actor = null, event, payload = {} }) {
  const run = runner?.query ? runner.query.bind(runner) : query
  await run(
    `INSERT INTO ad_events (campaign_id, vendor_id, actor_id, actor_kind, event, payload)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [campaignId, vendorId, actor?.userId || null, actor?.kind || 'SYSTEM', event, JSON.stringify(payload)]
  )
}

// ── Ad wallet ───────────────────────────────────────────────────────────

/** Lock (creating if needed) the vendor's wallet row. Must be inside a transaction. */
export async function lockWallet(client, vendorId) {
  await client.query(`INSERT INTO ad_wallets (vendor_id) VALUES ($1) ON CONFLICT DO NOTHING`, [vendorId])
  const { rows } = await client.query(`SELECT * FROM ad_wallets WHERE vendor_id = $1 FOR UPDATE`, [vendorId])
  return rows[0]
}

/**
 * Post one signed ledger movement and update the cached balance atomically.
 * `amountPaise` is signed and gross (includes tax for click charges).
 * Idempotent on `idempotencyKey`: a replay returns `{ replayed: true }` and changes nothing.
 * Throws INSUFFICIENT_FUNDS rather than letting the balance go negative.
 */
export async function postWalletEntry(client, {
  vendorId, entryType, amountPaise, taxPaise = 0, campaignId = null, clickId = null,
  reason = null, actorId = null, idempotencyKey = null,
}) {
  if (idempotencyKey) {
    const { rows } = await client.query(`SELECT id FROM ad_wallet_ledger WHERE idempotency_key = $1`, [idempotencyKey])
    if (rows[0]) return { replayed: true }
  }
  if (!amountPaise) throw new AdsError('VALIDATION', 'Amount must not be zero', 422)
  const wallet = await lockWallet(client, vendorId)
  const next = toPaise(wallet.balance) + amountPaise
  if (next < 0) throw new AdsError('INSUFFICIENT_FUNDS', 'Not enough ad wallet balance', 402, { balance: Number(wallet.balance) })
  const spendDelta = entryType === 'CLICK_CHARGE' ? -amountPaise : entryType === 'CLICK_REFUND' ? -amountPaise : 0
  const topupDelta = ['TOPUP_SETTLEMENT', 'TOPUP_ADMIN'].includes(entryType) ? amountPaise : 0
  await client.query(
    `INSERT INTO ad_wallet_ledger (vendor_id, entry_type, amount, tax_amount, balance_after, campaign_id, click_id, reason, actor_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [vendorId, entryType, fromPaise(amountPaise), fromPaise(taxPaise), fromPaise(next), campaignId, clickId, reason, actorId, idempotencyKey]
  )
  await client.query(
    `UPDATE ad_wallets SET balance = $2, lifetime_spend = lifetime_spend + $3, lifetime_topup = lifetime_topup + $4, updated_at = NOW()
      WHERE vendor_id = $1`,
    [vendorId, fromPaise(next), fromPaise(spendDelta), fromPaise(topupDelta)]
  )
  return { replayed: false, balance: fromPaise(next) }
}

export const IST_DAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`
