/**
 * Ad campaign management — used by platform admins (any vendor) and vendors (own only).
 *
 * `actor` = { kind: 'ADMIN' | 'VENDOR', userId, vendorId }
 * Vendor actors are hard-scoped by vendor_id; a foreign campaign answers 404, never 403.
 *
 * @module modules/ads/ads-manage.service
 */

import { query } from '../../config/database.js'
import { fromPaise, keywordMatches, normalizeText, toPaise } from './ads-engine.js'
import { AdsError, getSettings, invalidateSettingsCache, IST_DAY_SQL, logEvent, withTx } from './ads.shared.js'
import { getWallet } from './ads-billing.service.js'

const isAdmin = (a) => a.kind === 'ADMIN'
const notFound = (what = 'Campaign') => new AdsError('NOT_FOUND', `${what} not found`, 404)
const money = (v, field, { required = true } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AdsError('VALIDATION', `${field} is required`, 422)
    return null
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new AdsError('VALIDATION', `${field} must be a positive amount`, 422)
  return Math.round(n * 100) / 100
}
const dateOnly = (v, field, { required = false } = {}) => {
  if (!v) { if (required) throw new AdsError('VALIDATION', `${field} is required`, 422); return null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw new AdsError('VALIDATION', `${field} must be YYYY-MM-DD`, 422)
  return String(v)
}

/** Resolve which vendor an operation is for. Admins must name one when creating. */
function vendorFor(actor, requested) {
  if (!isAdmin(actor)) {
    if (!actor.vendorId) throw new AdsError('FORBIDDEN', 'Vendor access required', 403)
    return actor.vendorId
  }
  return requested || actor.vendorId || null
}

async function loadCampaign(actor, id, client = null, { lock = false } = {}) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run(`SELECT * FROM ad_campaigns WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])
  const c = rows[0]
  if (!c || (!isAdmin(actor) && c.vendor_id !== actor.vendorId)) throw notFound()
  return c
}

// ── Rules / settings ────────────────────────────────────────────────────

export async function rules() {
  const s = await getSettings()
  return {
    enabled: s.enabled, campaigns_require_approval: s.campaigns_require_approval,
    min_cpc: Number(s.min_cpc), max_cpc: Number(s.max_cpc), min_daily_budget: Number(s.min_daily_budget),
    min_topup: Number(s.min_topup), max_topup: Number(s.max_topup), gst_pct: Number(s.gst_pct),
    slots_per_page: s.slots_per_page, attribution_window_days: s.attribution_window_days,
    max_products_per_campaign: s.max_products_per_campaign, max_keywords_per_campaign: s.max_keywords_per_campaign,
    max_campaigns_per_vendor: s.max_campaigns_per_vendor,
  }
}

const SETTING_FIELDS = {
  enabled: 'bool', campaigns_require_approval: 'bool',
  min_cpc: 'num', max_cpc: 'num', min_daily_budget: 'num', min_topup: 'num', max_topup: 'num', gst_pct: 'num',
  slots_per_page: 'int', first_slot_position: 'int', slot_spacing: 'int', max_ads_per_vendor_per_page: 'int',
  min_quality_score: 'num', click_dedupe_minutes: 'int', impression_token_ttl_minutes: 'int', attribution_window_days: 'int',
  max_campaigns_per_vendor: 'int', max_products_per_campaign: 'int', max_keywords_per_campaign: 'int', low_balance_threshold: 'num',
}

export async function getSettingsForAdmin() {
  const s = await getSettings()
  return Object.fromEntries(Object.keys(SETTING_FIELDS).map((k) => [k, typeof s[k] === 'string' ? Number(s[k]) : s[k]]))
}

export async function updateSettings(actor, body) {
  const sets = []
  const params = []
  for (const [k, type] of Object.entries(SETTING_FIELDS)) {
    if (body[k] === undefined) continue
    let v = body[k]
    if (type === 'bool') v = v === true || v === 'true'
    else {
      v = Number(v)
      if (!Number.isFinite(v)) throw new AdsError('VALIDATION', `${k} must be a number`, 422)
      if (type === 'int' && !Number.isInteger(v)) throw new AdsError('VALIDATION', `${k} must be a whole number`, 422)
    }
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  if (!sets.length) return getSettingsForAdmin()
  params.push(actor.userId || null)
  try {
    await query(`UPDATE ad_settings SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = NOW() WHERE id = TRUE`, params)
  } catch (err) {
    if (err.code === '23514') throw new AdsError('VALIDATION', 'One of the values is outside its allowed range (max CPC must be ≥ min CPC, max top-up ≥ min top-up)', 422)
    throw err
  }
  invalidateSettingsCache()
  await logEvent(null, { actor, event: 'SETTINGS_UPDATED', payload: body })
  return getSettingsForAdmin()
}

// ── Product search (for the campaign builder) ───────────────────────────

export async function searchProducts(actor, { q = '', vendorId = null, limit = 30 } = {}) {
  const vid = vendorFor(actor, vendorId)
  if (!vid) throw new AdsError('VALIDATION', 'Choose a vendor', 422)
  const params = [vid]
  let extra = ''
  if (q) { params.push(`%${q}%`); extra = `AND (p.name ILIKE $2 OR p.brand ILIKE $2 OR sp.seller_sku ILIKE $2)` }
  const { rows } = await query(
    `SELECT DISTINCT ON (p.id) p.id, p.name, p.brand, p.thumbnail_url AS thumbnail, p.rating_avg, p.rating_count,
            COALESCE(sp.sale_price, sp.price) AS price, sp.stock_quantity, sp.seller_sku, sp.id AS shop_product_id
       FROM shop_products sp
       JOIN shops s ON s.id = sp.shop_id AND s.vendor_id = $1
       JOIN products p ON p.id = sp.product_id AND p.deleted_at IS NULL AND p.is_active = TRUE
      WHERE sp.deleted_at IS NULL AND sp.listing_status = 'ACTIVE' AND sp.approval_status = 'APPROVED' ${extra}
      ORDER BY p.id, sp.stock_quantity DESC
      LIMIT ${Math.min(50, limit)}`, params)
  return rows
}

async function assertVendorOwnsProducts(client, vendorId, productIds) {
  const { rows } = await client.query(
    `SELECT DISTINCT sp.product_id, sp.id AS shop_product_id FROM shop_products sp
       JOIN shops s ON s.id = sp.shop_id AND s.vendor_id = $1
      WHERE sp.product_id = ANY($2::uuid[]) AND sp.deleted_at IS NULL`, [vendorId, productIds])
  const found = new Map(rows.map((r) => [r.product_id, r.shop_product_id]))
  const missing = productIds.filter((id) => !found.has(id))
  if (missing.length) throw new AdsError('NOT_YOUR_PRODUCT', 'You can only advertise products you sell', 403, { missing })
  return found
}

// ── Keyword helpers ─────────────────────────────────────────────────────

function parseKeywords(list, s) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const item = typeof raw === 'string' ? { keyword: raw } : raw
    const keyword = normalizeText(item?.keyword)
    if (!keyword) continue
    if (keyword.length > 80) throw new AdsError('VALIDATION', `Keyword "${keyword.slice(0, 20)}…" is too long`, 422)
    if (keyword.split(' ').length > 10) throw new AdsError('VALIDATION', 'Keywords can have at most 10 words', 422)
    const matchType = String(item.matchType || item.match_type || 'BROAD').toUpperCase()
    if (!['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) throw new AdsError('VALIDATION', 'matchType must be EXACT, PHRASE or BROAD', 422)
    const isNegative = item.negative === true || item.is_negative === true
    const bid = item.bid == null || item.bid === '' ? null : money(item.bid, 'bid')
    if (bid != null && (bid < Number(s.min_cpc) || bid > Number(s.max_cpc))) {
      throw new AdsError('VALIDATION', `Bid must be between ₹${Number(s.min_cpc)} and ₹${Number(s.max_cpc)}`, 422)
    }
    const id = `${keyword}|${matchType}|${isNegative}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ keyword, matchType, isNegative, bid })
  }
  return out
}

async function insertKeywords(client, campaignId, list, s) {
  if (!list.length) return
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ad_keywords WHERE campaign_id = $1`, [campaignId])
  if (rows[0].n + list.length > s.max_keywords_per_campaign) {
    throw new AdsError('LIMIT', `A campaign can have at most ${s.max_keywords_per_campaign} keywords`, 422)
  }
  for (const k of list) {
    await client.query(
      `INSERT INTO ad_keywords (campaign_id, keyword, match_type, is_negative, bid) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (campaign_id, keyword, match_type, is_negative) DO UPDATE SET bid = EXCLUDED.bid, status = 'ACTIVE'`,
      [campaignId, k.keyword, k.matchType, k.isNegative, k.bid])
  }
}

// ── Create / update ─────────────────────────────────────────────────────

function validateCampaignFields(body, s, { partial = false } = {}) {
  const out = {}
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim()
    if (name.length < 3 || name.length > 120) throw new AdsError('VALIDATION', 'Campaign name must be 3–120 characters', 422)
    out.name = name
  }
  if (!partial || body.targeting !== undefined) {
    const t = String(body.targeting || 'AUTO').toUpperCase()
    if (!['AUTO', 'MANUAL'].includes(t)) throw new AdsError('VALIDATION', 'targeting must be AUTO or MANUAL', 422)
    out.targeting = t
  }
  if (!partial || body.defaultBid !== undefined) {
    const bid = money(body.defaultBid, 'Default bid')
    if (bid < Number(s.min_cpc) || bid > Number(s.max_cpc)) throw new AdsError('VALIDATION', `Bid must be between ₹${Number(s.min_cpc)} and ₹${Number(s.max_cpc)}`, 422)
    out.default_bid = bid
  }
  if (!partial || body.dailyBudget !== undefined) {
    const d = money(body.dailyBudget, 'Daily budget')
    if (d < Number(s.min_daily_budget)) throw new AdsError('VALIDATION', `Daily budget must be at least ₹${Number(s.min_daily_budget)}`, 422)
    out.daily_budget = d
  }
  if (body.totalBudget !== undefined) out.total_budget = money(body.totalBudget, 'Total budget', { required: false })
  if (body.startsOn !== undefined || !partial) out.starts_on = dateOnly(body.startsOn, 'Start date')
  if (body.endsOn !== undefined) out.ends_on = dateOnly(body.endsOn, 'End date')
  return out
}

export async function createCampaign(actor, body) {
  const s = await getSettings()
  if (!s.enabled) throw new AdsError('ADS_DISABLED', 'Sponsored ads are currently unavailable', 503)
  const vendorId = vendorFor(actor, body.vendorId)
  if (!vendorId) throw new AdsError('VALIDATION', 'Choose a vendor for this campaign', 422)
  const f = validateCampaignFields(body, s)
  const productIds = [...new Set(Array.isArray(body.productIds) ? body.productIds : [])]
  if (productIds.length > s.max_products_per_campaign) throw new AdsError('LIMIT', `A campaign can promote at most ${s.max_products_per_campaign} products`, 422)
  const keywords = parseKeywords(body.keywords, s)

  const id = await withTx(async (client) => {
    const { rows: v } = await client.query(`SELECT id, status FROM vendors WHERE id = $1 FOR SHARE`, [vendorId])
    if (!v[0]) throw notFound('Vendor')
    const { rows: cnt } = await client.query(`SELECT COUNT(*)::int AS n FROM ad_campaigns WHERE vendor_id = $1 AND status <> 'ENDED'`, [vendorId])
    if (cnt[0].n >= s.max_campaigns_per_vendor) throw new AdsError('LIMIT', `You can run at most ${s.max_campaigns_per_vendor} campaigns at once`, 422)
    const startsOn = f.starts_on || (await client.query(`SELECT ${IST_DAY_SQL} AS d`)).rows[0].d
    if (f.ends_on && new Date(f.ends_on) < new Date(startsOn)) throw new AdsError('VALIDATION', 'End date must be after the start date', 422)
    if (f.total_budget != null && f.total_budget < f.daily_budget) throw new AdsError('VALIDATION', 'Total budget cannot be lower than the daily budget', 422)

    const { rows } = await client.query(
      `INSERT INTO ad_campaigns (campaign_number, vendor_id, name, targeting, default_bid, daily_budget, total_budget, starts_on, ends_on, created_by)
       VALUES ('AD-' || nextval('ad_campaign_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [vendorId, f.name, f.targeting, f.default_bid, f.daily_budget, f.total_budget ?? null, startsOn, f.ends_on ?? null, actor.userId || null])
    const cid = rows[0].id
    if (productIds.length) await addProductsTx(client, cid, vendorId, productIds, null)
    await insertKeywords(client, cid, keywords, s)
    await logEvent(client, { campaignId: cid, vendorId, actor, event: 'CREATED', payload: { name: f.name, targeting: f.targeting } })
    return cid
  })
  if (body.submit === true) await submit(actor, id)
  return getCampaign(actor, id)
}

export async function updateCampaign(actor, id, body) {
  const s = await getSettings()
  return withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    if (c.status === 'ENDED') throw new AdsError('CAMPAIGN_ENDED', 'An ended campaign cannot be edited', 409)
    const f = validateCampaignFields(body, s, { partial: true })
    delete f.targeting // targeting is fixed after creation: it changes what the campaign means
    const merged = { ...c, ...f }
    if (merged.total_budget != null && Number(merged.total_budget) < Number(merged.daily_budget)) throw new AdsError('VALIDATION', 'Total budget cannot be lower than the daily budget', 422)
    if (merged.ends_on && merged.starts_on && new Date(merged.ends_on) < new Date(merged.starts_on)) throw new AdsError('VALIDATION', 'End date must be after the start date', 422)
    const cols = Object.keys(f)
    if (cols.length) {
      await client.query(
        `UPDATE ad_campaigns SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
        [id, ...cols.map((k) => f[k])])
      await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'UPDATED', payload: body })
    }
    return null
  }).then(() => getCampaign(actor, id))
}

// ── Products & keywords on a campaign ───────────────────────────────────

async function addProductsTx(client, campaignId, vendorId, productIds, bidOverride) {
  const owned = await assertVendorOwnsProducts(client, vendorId, productIds)
  for (const pid of productIds) {
    await client.query(
      `INSERT INTO ad_campaign_products (campaign_id, product_id, shop_product_id, bid_override) VALUES ($1,$2,$3,$4)
       ON CONFLICT (campaign_id, product_id) DO UPDATE SET status = 'ACTIVE', bid_override = COALESCE(EXCLUDED.bid_override, ad_campaign_products.bid_override)`,
      [campaignId, pid, owned.get(pid), bidOverride])
  }
}

export async function addProducts(actor, id, { productIds, bidOverride = null }) {
  const s = await getSettings()
  const ids = [...new Set(Array.isArray(productIds) ? productIds : [])]
  if (!ids.length) throw new AdsError('VALIDATION', 'Select at least one product', 422)
  const bid = bidOverride == null ? null : money(bidOverride, 'bid')
  if (bid != null && (bid < Number(s.min_cpc) || bid > Number(s.max_cpc))) throw new AdsError('VALIDATION', `Bid must be between ₹${Number(s.min_cpc)} and ₹${Number(s.max_cpc)}`, 422)
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    if (c.status === 'ENDED') throw new AdsError('CAMPAIGN_ENDED', 'An ended campaign cannot be edited', 409)
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ad_campaign_products WHERE campaign_id = $1 AND NOT (product_id = ANY($2::uuid[]))`, [id, ids])
    if (rows[0].n + ids.length > s.max_products_per_campaign) throw new AdsError('LIMIT', `A campaign can promote at most ${s.max_products_per_campaign} products`, 422)
    await addProductsTx(client, id, c.vendor_id, ids, bid)
    await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'PRODUCTS_ADDED', payload: { productIds: ids } })
  })
  return getCampaign(actor, id)
}

export async function updateProduct(actor, id, productId, { status, bidOverride }) {
  const s = await getSettings()
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    const sets = []
    const params = [id, productId]
    if (status) {
      if (!['ACTIVE', 'PAUSED'].includes(status)) throw new AdsError('VALIDATION', 'Invalid status', 422)
      params.push(status); sets.push(`status = $${params.length}`)
    }
    if (bidOverride !== undefined) {
      const bid = bidOverride === null ? null : money(bidOverride, 'bid')
      if (bid != null && (bid < Number(s.min_cpc) || bid > Number(s.max_cpc))) throw new AdsError('VALIDATION', `Bid must be between ₹${Number(s.min_cpc)} and ₹${Number(s.max_cpc)}`, 422)
      params.push(bid); sets.push(`bid_override = $${params.length}`)
    }
    if (!sets.length) return
    const r = await client.query(`UPDATE ad_campaign_products SET ${sets.join(', ')} WHERE campaign_id = $1 AND product_id = $2`, params)
    if (!r.rowCount) throw notFound('Product')
    await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'PRODUCT_UPDATED', payload: { productId, status, bidOverride } })
  })
  return getCampaign(actor, id)
}

export async function removeProduct(actor, id, productId) {
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    await client.query(`DELETE FROM ad_campaign_products WHERE campaign_id = $1 AND product_id = $2`, [id, productId])
    await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'PRODUCT_REMOVED', payload: { productId } })
  })
  return getCampaign(actor, id)
}

export async function addKeywords(actor, id, { keywords }) {
  const s = await getSettings()
  const list = parseKeywords(keywords, s)
  if (!list.length) throw new AdsError('VALIDATION', 'Enter at least one keyword', 422)
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    if (c.status === 'ENDED') throw new AdsError('CAMPAIGN_ENDED', 'An ended campaign cannot be edited', 409)
    await insertKeywords(client, id, list, s)
    await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'KEYWORDS_ADDED', payload: { count: list.length } })
  })
  return getCampaign(actor, id)
}

export async function updateKeyword(actor, id, keywordId, { status, bid }) {
  const s = await getSettings()
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    const sets = []
    const params = [id, keywordId]
    if (status) {
      if (!['ACTIVE', 'PAUSED'].includes(status)) throw new AdsError('VALIDATION', 'Invalid status', 422)
      params.push(status); sets.push(`status = $${params.length}`)
    }
    if (bid !== undefined) {
      const b = bid === null ? null : money(bid, 'bid')
      if (b != null && (b < Number(s.min_cpc) || b > Number(s.max_cpc))) throw new AdsError('VALIDATION', `Bid must be between ₹${Number(s.min_cpc)} and ₹${Number(s.max_cpc)}`, 422)
      params.push(b); sets.push(`bid = $${params.length}`)
    }
    if (!sets.length) return
    const r = await client.query(`UPDATE ad_keywords SET ${sets.join(', ')} WHERE campaign_id = $1 AND id = $2`, params)
    if (!r.rowCount) throw notFound('Keyword')
    await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'KEYWORD_UPDATED', payload: { keywordId, status, bid } })
  })
  return getCampaign(actor, id)
}

export async function removeKeyword(actor, id, keywordId) {
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    await client.query(`DELETE FROM ad_keywords WHERE campaign_id = $1 AND id = $2`, [id, keywordId])
    await logEvent(client, { campaignId: id, vendorId: c.vendor_id, actor, event: 'KEYWORD_REMOVED', payload: { keywordId } })
  })
  return getCampaign(actor, id)
}

// ── Lifecycle ───────────────────────────────────────────────────────────

async function transition(actor, id, fn) {
  await withTx(async (client) => {
    const c = await loadCampaign(actor, id, client, { lock: true })
    await fn(client, c)
  })
  return getCampaign(actor, id)
}

const setStatus = (client, c, actor, status, event, extra = {}, payload = {}) =>
  client.query(
    `UPDATE ad_campaigns SET status = $2, updated_at = NOW(),
            rejected_reason = COALESCE($3, rejected_reason), suspended_reason = COALESCE($4, suspended_reason),
            paused_reason = $5, reviewed_by = COALESCE($6, reviewed_by), reviewed_at = COALESCE($7::timestamptz, reviewed_at)
      WHERE id = $1`,
    [c.id, status, extra.rejected ?? null, extra.suspended ?? null, extra.paused ?? null, extra.reviewedBy ?? null, extra.reviewedAt ?? null])
    .then(() => logEvent(client, { campaignId: c.id, vendorId: c.vendor_id, actor, event, payload: { from: c.status, to: status, ...payload } }))

/** DRAFT / REJECTED → PENDING_REVIEW (or straight to ACTIVE when approval isn't required). */
export function submit(actor, id) {
  return transition(actor, id, async (client, c) => {
    if (!['DRAFT', 'REJECTED'].includes(c.status)) throw new AdsError('INVALID_STATE', `A ${c.status.toLowerCase().replace('_', ' ')} campaign cannot be submitted`, 409)
    const s = await getSettings(client)
    const { rows: p } = await client.query(`SELECT COUNT(*)::int AS n FROM ad_campaign_products WHERE campaign_id = $1 AND status = 'ACTIVE'`, [c.id])
    if (!p[0].n) throw new AdsError('INCOMPLETE', 'Add at least one product to advertise', 422)
    if (c.targeting === 'MANUAL') {
      const { rows: k } = await client.query(`SELECT COUNT(*)::int AS n FROM ad_keywords WHERE campaign_id = $1 AND status = 'ACTIVE' AND NOT is_negative`, [c.id])
      if (!k[0].n) throw new AdsError('INCOMPLETE', 'Manual campaigns need at least one keyword', 422)
    }
    if (!s.campaigns_require_approval || isAdmin(actor)) {
      await setStatus(client, c, actor, 'ACTIVE', 'ACTIVATED', { reviewedBy: actor.userId, reviewedAt: new Date().toISOString() })
    } else {
      await setStatus(client, c, actor, 'PENDING_REVIEW', 'SUBMITTED')
    }
  })
}

export function pause(actor, id) {
  return transition(actor, id, async (client, c) => {
    if (c.status !== 'ACTIVE') throw new AdsError('INVALID_STATE', 'Only active campaigns can be paused', 409)
    await setStatus(client, c, actor, 'PAUSED', 'PAUSED', { paused: 'MANUAL' })
  })
}

export function resume(actor, id) {
  return transition(actor, id, async (client, c) => {
    if (c.status !== 'PAUSED') throw new AdsError('INVALID_STATE', 'Only paused campaigns can be resumed', 409)
    if (c.ends_on && new Date(c.ends_on) < new Date()) throw new AdsError('CAMPAIGN_ENDED', 'This campaign has passed its end date — extend it first', 409)
    const s = await getSettings(client)
    const { rows } = await client.query(`SELECT balance FROM ad_wallets WHERE vendor_id = $1`, [c.vendor_id])
    const need = Math.ceil(Number(s.min_cpc) * (1 + Number(s.gst_pct) / 100))
    if (Number(rows[0]?.balance || 0) < need) throw new AdsError('INSUFFICIENT_FUNDS', 'Add money to your ad wallet before resuming', 402)
    await setStatus(client, c, actor, 'ACTIVE', 'RESUMED')
  })
}

export function end(actor, id) {
  return transition(actor, id, async (client, c) => {
    if (c.status === 'ENDED') return
    await setStatus(client, c, actor, 'ENDED', 'ENDED')
  })
}

export function approve(actor, id) {
  return transition(actor, id, async (client, c) => {
    if (c.status !== 'PENDING_REVIEW') throw new AdsError('INVALID_STATE', 'Only campaigns pending review can be approved', 409)
    await setStatus(client, c, actor, 'ACTIVE', 'APPROVED', { reviewedBy: actor.userId, reviewedAt: new Date().toISOString() })
  })
}

export async function reject(actor, id, reason) {
  if (!reason || String(reason).trim().length < 3) throw new AdsError('VALIDATION', 'Tell the vendor why it was rejected', 422)
  return transition(actor, id, async (client, c) => {
    if (c.status !== 'PENDING_REVIEW') throw new AdsError('INVALID_STATE', 'Only campaigns pending review can be rejected', 409)
    await setStatus(client, c, actor, 'REJECTED', 'REJECTED', { rejected: String(reason).trim(), reviewedBy: actor.userId, reviewedAt: new Date().toISOString() }, { reason })
  })
}

export async function suspend(actor, id, reason) {
  if (!reason || String(reason).trim().length < 3) throw new AdsError('VALIDATION', 'A reason is required', 422)
  return transition(actor, id, async (client, c) => {
    if (!['ACTIVE', 'PAUSED', 'PENDING_REVIEW'].includes(c.status)) throw new AdsError('INVALID_STATE', 'This campaign cannot be suspended', 409)
    await setStatus(client, c, actor, 'SUSPENDED', 'SUSPENDED', { suspended: String(reason).trim() }, { reason })
  })
}

export function unsuspend(actor, id) {
  return transition(actor, id, async (client, c) => {
    if (c.status !== 'SUSPENDED') throw new AdsError('INVALID_STATE', 'Campaign is not suspended', 409)
    await setStatus(client, c, actor, 'PAUSED', 'UNSUSPENDED', { paused: 'MANUAL' })
  })
}

// ── Reads ───────────────────────────────────────────────────────────────

const AGG_30D = `
  COALESCE(SUM(st.impressions), 0)::int AS impressions_30d,
  COALESCE(SUM(st.clicks), 0)::int AS clicks_30d,
  COALESCE(SUM(st.spend), 0) AS spend_30d`

export async function listCampaigns(actor, { status = '', q = '', vendorId = null, page = 1, limit = 20 } = {}) {
  const params = []
  const where = ['1=1']
  if (!isAdmin(actor)) { params.push(actor.vendorId); where.push(`c.vendor_id = $${params.length}`) }
  else if (vendorId) { params.push(vendorId); where.push(`c.vendor_id = $${params.length}`) }
  if (status) { params.push(status.split(',')); where.push(`c.status = ANY($${params.length})`) }
  if (q) { params.push(`%${q}%`); where.push(`(c.name ILIKE $${params.length} OR c.campaign_number ILIKE $${params.length})`) }
  const offset = (Math.max(1, page) - 1) * limit
  const [{ rows }, { rows: cnt }, { rows: byStatus }] = await Promise.all([
    query(
      `SELECT c.*, v.name AS vendor_name,
              (SELECT COUNT(*)::int FROM ad_campaign_products WHERE campaign_id = c.id) AS product_count,
              (SELECT COUNT(*)::int FROM ad_keywords WHERE campaign_id = c.id AND NOT is_negative) AS keyword_count,
              COALESCE((SELECT SUM(spend) FROM ad_stats_daily WHERE campaign_id = c.id AND day = ${IST_DAY_SQL}), 0) AS spent_today,
              a.impressions_30d, a.clicks_30d, a.spend_30d
         FROM ad_campaigns c JOIN vendors v ON v.id = c.vendor_id
         LEFT JOIN LATERAL (SELECT ${AGG_30D} FROM ad_stats_daily st WHERE st.campaign_id = c.id AND st.day >= ${IST_DAY_SQL} - 29) a ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY (c.status = 'PENDING_REVIEW') DESC, c.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total FROM ad_campaigns c WHERE ${where.join(' AND ')}`, params),
    query(
      `SELECT c.status, COUNT(*)::int AS n FROM ad_campaigns c WHERE ${isAdmin(actor) ? (vendorId ? 'c.vendor_id = $1' : 'TRUE') : 'c.vendor_id = $1'} GROUP BY c.status`,
      isAdmin(actor) ? (vendorId ? [vendorId] : []) : [actor.vendorId]),
  ])
  return {
    data: rows.map(serializeCampaignRow),
    counts: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    pagination: { page: Number(page), limit, total: cnt[0].total },
  }
}

function serializeCampaignRow(r) {
  const impressions = Number(r.impressions_30d || 0)
  const clicks = Number(r.clicks_30d || 0)
  const spend = Number(r.spend_30d || 0)
  return {
    ...r,
    default_bid: Number(r.default_bid), daily_budget: Number(r.daily_budget),
    total_budget: r.total_budget == null ? null : Number(r.total_budget), spent_today: Number(r.spent_today),
    impressions_30d: impressions, clicks_30d: clicks, spend_30d: spend,
    ctr_30d: impressions ? clicks / impressions : 0, avg_cpc_30d: clicks ? spend / clicks : 0,
  }
}

export async function getCampaign(actor, id) {
  const c = await loadCampaign(actor, id)
  const [{ rows: products }, { rows: keywords }, { rows: events }, { rows: v }, { rows: agg }, { rows: today }] = await Promise.all([
    query(
      `SELECT cp.product_id, cp.status, cp.bid_override, p.name, p.brand, p.thumbnail_url AS thumbnail,
              (SELECT MIN(COALESCE(sp.sale_price, sp.price)) FROM shop_products sp JOIN shops s ON s.id = sp.shop_id
                WHERE sp.product_id = cp.product_id AND s.vendor_id = $2 AND sp.deleted_at IS NULL) AS price,
              (SELECT COALESCE(SUM(sp.stock_quantity), 0)::int FROM shop_products sp JOIN shops s ON s.id = sp.shop_id
                WHERE sp.product_id = cp.product_id AND s.vendor_id = $2 AND sp.deleted_at IS NULL AND sp.listing_status = 'ACTIVE') AS stock,
              COALESCE(SUM(st.impressions), 0)::int AS impressions, COALESCE(SUM(st.clicks), 0)::int AS clicks, COALESCE(SUM(st.spend), 0) AS spend
         FROM ad_campaign_products cp JOIN products p ON p.id = cp.product_id
         LEFT JOIN ad_stats_daily st ON st.campaign_id = cp.campaign_id AND st.product_id = cp.product_id AND st.day >= ${IST_DAY_SQL} - 29
        WHERE cp.campaign_id = $1 GROUP BY cp.product_id, cp.status, cp.bid_override, p.name, p.brand, p.thumbnail_url
        ORDER BY p.name`, [id, c.vendor_id]),
    query(
      `SELECT k.id, k.keyword, k.match_type, k.is_negative, k.bid, k.status,
              COALESCE(cl.clicks, 0)::int AS clicks, COALESCE(cl.spend, 0) AS spend
         FROM ad_keywords k
         LEFT JOIN LATERAL (SELECT COUNT(*) AS clicks, SUM(cpc) AS spend FROM ad_clicks
                             WHERE campaign_id = k.campaign_id AND keyword = k.keyword AND created_at >= NOW() - INTERVAL '30 days') cl ON TRUE
        WHERE k.campaign_id = $1 ORDER BY k.is_negative, k.keyword`, [id]),
    query(`SELECT e.event, e.payload, e.actor_kind, e.created_at FROM ad_events e WHERE e.campaign_id = $1 ORDER BY e.id DESC LIMIT 30`, [id]),
    query(`SELECT name FROM vendors WHERE id = $1`, [c.vendor_id]),
    query(`SELECT ${AGG_30D} FROM ad_stats_daily st WHERE st.campaign_id = $1 AND st.day >= ${IST_DAY_SQL} - 29`, [id]),
    query(`SELECT COALESCE(SUM(spend), 0) AS spent FROM ad_stats_daily WHERE campaign_id = $1 AND day = ${IST_DAY_SQL}`, [id]),
  ])
  const a = agg[0]
  const imp = Number(a.impressions_30d); const clk = Number(a.clicks_30d); const spend = Number(a.spend_30d)
  return {
    ...c,
    default_bid: Number(c.default_bid), daily_budget: Number(c.daily_budget), total_budget: c.total_budget == null ? null : Number(c.total_budget),
    vendor_name: v[0]?.name,
    spent_today: Number(today[0].spent),
    totals_30d: { impressions: imp, clicks: clk, spend, ctr: imp ? clk / imp : 0, avg_cpc: clk ? spend / clk : 0 },
    products: products.map((p) => ({ ...p, price: p.price == null ? null : Number(p.price), spend: Number(p.spend), bid_override: p.bid_override == null ? null : Number(p.bid_override) })),
    keywords: keywords.map((k) => ({ ...k, bid: k.bid == null ? null : Number(k.bid), spend: Number(k.spend) })),
    events,
  }
}

// ── Reporting (with order attribution) ──────────────────────────────────

const ATTRIBUTION_CTE = `
  attributed AS (
    SELECT DISTINCT ON (oi.id) oi.id AS item_id, c.campaign_id, c.product_id, c.keyword, oi.total
      FROM ad_clicks c
      JOIN orders o ON o.user_id = c.user_id AND o.created_at >= c.created_at
                   AND o.created_at < c.created_at + make_interval(days => $WIN)
                   AND o.status::text NOT IN ('CANCELLED', 'REFUNDED', 'RETURNED', 'FAILED', 'PAYMENT_FAILED', 'REJECTED')
      JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = c.product_id
     WHERE c.user_id IS NOT NULL AND c.created_at >= $SINCE AND c.refunded = FALSE AND $SCOPE
     ORDER BY oi.id, c.created_at DESC
  )`

/** Orders + sales attributed to ad clicks within the attribution window (last-click, per order line). */
async function attribution(scopeSql, scopeParams, since, windowDays) {
  const params = [...scopeParams, since, windowDays]
  const sinceIdx = scopeParams.length + 1
  const winIdx = scopeParams.length + 2
  const cte = ATTRIBUTION_CTE.replace('$SINCE', `$${sinceIdx}`).replace('$WIN', `$${winIdx}`).replace('$SCOPE', scopeSql)
  return { cte, params }
}

export async function campaignReport(actor, id, { days = 30 } = {}) {
  const c = await loadCampaign(actor, id)
  const s = await getSettings()
  const d = Math.min(90, Math.max(1, Number(days) || 30))
  const since = new Date(Date.now() - d * 86400_000).toISOString()
  const { cte, params } = await attribution('c.campaign_id = $1', [id], since, s.attribution_window_days)

  const [{ rows: daily }, { rows: prod }, { rows: kw }, { rows: tot }] = await Promise.all([
    query(
      `WITH ${cte},
            days AS (SELECT generate_series(${IST_DAY_SQL} - ($${params.length + 1}::int - 1), ${IST_DAY_SQL}, '1 day')::date AS day)
       SELECT d.day, COALESCE(SUM(st.impressions), 0)::int AS impressions, COALESCE(SUM(st.clicks), 0)::int AS clicks, COALESCE(SUM(st.spend), 0) AS spend
         FROM days d LEFT JOIN ad_stats_daily st ON st.campaign_id = $1 AND st.day = d.day
        GROUP BY d.day ORDER BY d.day`, [...params, d]),
    query(
      `WITH ${cte}
       SELECT p.id AS product_id, p.name, COALESCE(SUM(st.impressions), 0)::int AS impressions, COALESCE(SUM(st.clicks), 0)::int AS clicks,
              COALESCE(SUM(st.spend), 0) AS spend,
              (SELECT COUNT(*)::int FROM attributed a WHERE a.product_id = p.id) AS orders,
              (SELECT COALESCE(SUM(total), 0) FROM attributed a WHERE a.product_id = p.id) AS sales
         FROM ad_campaign_products cp JOIN products p ON p.id = cp.product_id
         LEFT JOIN ad_stats_daily st ON st.campaign_id = cp.campaign_id AND st.product_id = cp.product_id AND st.day >= (${IST_DAY_SQL} - ($${params.length + 1}::int - 1))
        WHERE cp.campaign_id = $1 GROUP BY p.id, p.name ORDER BY spend DESC`, [...params, d]),
    query(
      `WITH ${cte}
       SELECT k.keyword, k.match_type, COUNT(*)::int AS clicks, COALESCE(SUM(k.cpc), 0) AS spend,
              (SELECT COUNT(*)::int FROM attributed a WHERE a.keyword = k.keyword) AS orders,
              (SELECT COALESCE(SUM(total), 0) FROM attributed a WHERE a.keyword = k.keyword) AS sales
         FROM (SELECT cl.keyword, cl.cpc, kw.match_type FROM ad_clicks cl
                 LEFT JOIN LATERAL (SELECT match_type FROM ad_keywords WHERE campaign_id = cl.campaign_id AND keyword = cl.keyword AND NOT is_negative LIMIT 1) kw ON TRUE
                WHERE cl.campaign_id = $1 AND cl.keyword IS NOT NULL AND cl.created_at >= $${params.length - 1}) k
        GROUP BY k.keyword, k.match_type ORDER BY spend DESC LIMIT 100`, params),
    query(
      `WITH ${cte} SELECT COUNT(*)::int AS orders, COALESCE(SUM(total), 0) AS sales FROM attributed`, params),
  ])

  const sum = (k) => daily.reduce((n, r) => n + Number(r[k]), 0)
  const impressions = sum('impressions'); const clicks = sum('clicks'); const spend = sum('spend')
  const sales = Number(tot[0].sales)
  return {
    campaign: { id: c.id, name: c.name, campaign_number: c.campaign_number, status: c.status },
    range_days: d, attribution_window_days: s.attribution_window_days,
    totals: {
      impressions, clicks, spend, orders: tot[0].orders, sales,
      ctr: impressions ? clicks / impressions : 0, avg_cpc: clicks ? spend / clicks : 0,
      acos: sales ? spend / sales : null, roas: spend ? sales / spend : null,
    },
    daily: daily.map((r) => ({ day: r.day, impressions: r.impressions, clicks: r.clicks, spend: Number(r.spend) })),
    products: prod.map((r) => ({ ...r, spend: Number(r.spend), sales: Number(r.sales), acos: Number(r.sales) ? Number(r.spend) / Number(r.sales) : null })),
    keywords: kw.map((r) => ({ ...r, spend: Number(r.spend), sales: Number(r.sales), acos: Number(r.sales) ? Number(r.spend) / Number(r.sales) : null })),
  }
}

/** Dashboard overview: vendor sees their account; admin sees the whole platform (or one vendor). */
export async function overview(actor, { days = 30, vendorId = null } = {}) {
  const d = Math.min(90, Math.max(1, Number(days) || 30))
  const s = await getSettings()
  const scopeVendor = isAdmin(actor) ? vendorId : actor.vendorId
  const vparams = scopeVendor ? [scopeVendor] : []
  const vfilter = scopeVendor ? 'AND c.vendor_id = $1' : ''
  const since = new Date(Date.now() - d * 86400_000).toISOString()
  const attr = await attribution(scopeVendor ? 'c.vendor_id = $1' : 'TRUE', vparams, since, s.attribution_window_days)

  const [{ rows: t }, { rows: series }, { rows: counts }, { rows: sales }] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(st.impressions), 0)::int AS impressions, COALESCE(SUM(st.clicks), 0)::int AS clicks, COALESCE(SUM(st.spend), 0) AS spend
         FROM ad_stats_daily st JOIN ad_campaigns c ON c.id = st.campaign_id
        WHERE st.day >= ${IST_DAY_SQL} - ${d - 1} ${vfilter}`, vparams),
    query(
      `SELECT st.day, SUM(st.impressions)::int AS impressions, SUM(st.clicks)::int AS clicks, SUM(st.spend) AS spend
         FROM ad_stats_daily st JOIN ad_campaigns c ON c.id = st.campaign_id
        WHERE st.day >= ${IST_DAY_SQL} - ${d - 1} ${vfilter} GROUP BY st.day ORDER BY st.day`, vparams),
    query(`SELECT c.status, COUNT(*)::int AS n FROM ad_campaigns c WHERE TRUE ${vfilter} GROUP BY c.status`, vparams),
    query(`WITH ${attr.cte} SELECT COUNT(*)::int AS orders, COALESCE(SUM(total), 0) AS sales FROM attributed`, attr.params),
  ])
  const imp = t[0].impressions; const clk = t[0].clicks; const spend = Number(t[0].spend)
  const attributedSales = Number(sales[0].sales)
  const out = {
    range_days: d,
    totals: {
      impressions: imp, clicks: clk, spend, orders: sales[0].orders, sales: attributedSales,
      ctr: imp ? clk / imp : 0, avg_cpc: clk ? spend / clk : 0, acos: attributedSales ? spend / attributedSales : null, roas: spend ? attributedSales / spend : null,
    },
    daily: series.map((r) => ({ day: r.day, impressions: r.impressions, clicks: r.clicks, spend: Number(r.spend) })),
    campaign_counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
  }
  if (scopeVendor) out.wallet = await getWallet(scopeVendor)
  if (isAdmin(actor) && !vendorId) out.platform = await platformSummary(d)
  return out
}

async function platformSummary(d) {
  const [{ rows: rev }, { rows: liab }, { rows: top }, { rows: pend }] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(-amount) FILTER (WHERE entry_type = 'CLICK_CHARGE'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'CLICK_REFUND'), 0) AS gross_revenue,
              COALESCE(SUM(tax_amount) FILTER (WHERE entry_type = 'CLICK_CHARGE'), 0)
            - COALESCE(SUM(tax_amount) FILTER (WHERE entry_type = 'CLICK_REFUND'), 0) AS gst_collected,
              COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('TOPUP_SETTLEMENT','TOPUP_ADMIN')), 0) AS topups,
              COALESCE(SUM(amount) FILTER (WHERE entry_type = 'PROMO_CREDIT'), 0) AS promo_credits
         FROM ad_wallet_ledger WHERE created_at >= NOW() - make_interval(days => $1)`, [d]),
    query(`SELECT COALESCE(SUM(balance), 0) AS wallet_liability, COUNT(*) FILTER (WHERE balance > 0)::int AS funded_vendors FROM ad_wallets`),
    query(
      `SELECT v.id AS vendor_id, v.name, SUM(st.spend) AS spend, SUM(st.clicks)::int AS clicks
         FROM ad_stats_daily st JOIN ad_campaigns c ON c.id = st.campaign_id JOIN vendors v ON v.id = c.vendor_id
        WHERE st.day >= ${IST_DAY_SQL} - ${d - 1} GROUP BY v.id, v.name ORDER BY spend DESC LIMIT 10`),
    query(`SELECT COUNT(*)::int AS n FROM ad_campaigns WHERE status = 'PENDING_REVIEW'`),
  ])
  const gross = Number(rev[0].gross_revenue); const gst = Number(rev[0].gst_collected)
  return {
    net_revenue: Number((gross - gst).toFixed(2)), gst_collected: gst, gross_billed: gross,
    topups: Number(rev[0].topups), promo_credits: Number(rev[0].promo_credits),
    wallet_liability: Number(liab[0].wallet_liability), funded_vendors: liab[0].funded_vendors,
    pending_review: pend[0].n,
    top_advertisers: top.map((r) => ({ ...r, spend: Number(r.spend) })),
  }
}

// ── Bid research ────────────────────────────────────────────────────────

/** "How much will it cost?" — competition and recent prices for a keyword. */
export async function estimate(actor, { keyword = '', matchType = 'BROAD' } = {}) {
  const s = await getSettings()
  const kw = normalizeText(keyword)
  if (!kw) throw new AdsError('VALIDATION', 'Enter a keyword', 422)
  const { rows } = await query(
    `SELECT k.campaign_id, k.match_type, k.keyword, COALESCE(k.bid, c.default_bid) AS bid, c.vendor_id
       FROM ad_keywords k JOIN ad_campaigns c ON c.id = k.campaign_id
      WHERE c.status = 'ACTIVE' AND k.status = 'ACTIVE' AND NOT k.is_negative`)
  const competing = rows.filter((r) => keywordMatches(r.match_type, r.keyword, kw))
  const bids = competing.map((r) => Number(r.bid)).sort((a, b) => b - a)
  const { rows: paid } = await query(
    `SELECT COUNT(*)::int AS clicks, AVG(cpc) AS avg_cpc, PERCENTILE_CONT(0.8) WITHIN GROUP (ORDER BY cpc) AS p80
       FROM ad_clicks WHERE charged AND keyword = $1 AND created_at >= NOW() - INTERVAL '30 days'`, [kw])
  const floor = Number(s.min_cpc)
  const topBid = bids[0] || 0
  const p80 = paid[0].p80 ? Number(paid[0].p80) : null
  const suggested = Math.min(Number(s.max_cpc), Math.max(floor, p80 ?? 0, topBid ? topBid * 0.9 : 0, floor * 2))
  return {
    keyword: kw, match_type: matchType,
    competing_campaigns: new Set(competing.map((r) => r.campaign_id)).size,
    highest_bid: topBid || null,
    recent_clicks_30d: paid[0].clicks, avg_cpc_30d: paid[0].avg_cpc ? Number(Number(paid[0].avg_cpc).toFixed(2)) : null,
    floor, ceiling: Number(s.max_cpc),
    suggested_bid: Number(suggested.toFixed(2)),
    competition: bids.length >= 5 ? 'HIGH' : bids.length >= 2 ? 'MEDIUM' : 'LOW',
    gst_pct: Number(s.gst_pct),
    note: 'You pay the lowest price that keeps your position — usually less than your bid — plus GST.',
  }
}

// ── Admin: click review ─────────────────────────────────────────────────

export async function recentClicks(actor, id, { limit = 50 } = {}) {
  await loadCampaign(actor, id)
  const { rows } = await query(
    `SELECT cl.id, cl.created_at, cl.keyword, cl.cpc, cl.tax_amount, cl.charged, cl.not_charged_reason, cl.refunded, cl.ip,
            cl.user_id, p.name AS product_name
       FROM ad_clicks cl JOIN products p ON p.id = cl.product_id
      WHERE cl.campaign_id = $1 ORDER BY cl.created_at DESC LIMIT $2`, [id, Math.min(200, limit)])
  return rows.map((r) => ({ ...r, cpc: Number(r.cpc), tax_amount: Number(r.tax_amount), ip: isAdmin(actor) ? r.ip : undefined, user_id: isAdmin(actor) ? r.user_id : undefined }))
}

export async function vendorWallets({ q = '', page = 1, limit = 20 } = {}) {
  const params = []
  let where = ''
  if (q) { params.push(`%${q}%`); where = `WHERE v.name ILIKE $1` }
  const offset = (Math.max(1, page) - 1) * limit
  const [{ rows }, { rows: cnt }] = await Promise.all([
    query(
      `SELECT v.id AS vendor_id, v.name, COALESCE(w.balance, 0) AS balance, COALESCE(w.lifetime_topup, 0) AS lifetime_topup,
              COALESCE(w.lifetime_spend, 0) AS lifetime_spend,
              (SELECT COUNT(*)::int FROM ad_campaigns c WHERE c.vendor_id = v.id AND c.status = 'ACTIVE') AS active_campaigns
         FROM vendors v LEFT JOIN ad_wallets w ON w.vendor_id = v.id ${where}
        ORDER BY COALESCE(w.lifetime_spend, 0) DESC, v.name LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total FROM vendors v ${where}`, params),
  ])
  return { data: rows.map((r) => ({ ...r, balance: Number(r.balance), lifetime_topup: Number(r.lifetime_topup), lifetime_spend: Number(r.lifetime_spend) })), pagination: { page: Number(page), limit, total: cnt[0].total } }
}

export { fromPaise, toPaise }
