/**
 * Sell & Exchange requests — service layer (customer, admin and vendor surfaces).
 *
 * Lifecycle:  PENDING → IN_PROGRESS (vendor assigned) → APPROVED → COMPLETED
 *             PENDING / IN_PROGRESS → REJECTED;  any non-terminal → CANCELLED
 *
 * Invariants
 *  - The quote is always computed here from the QA answers; the client never supplies it.
 *  - One live request per IMEI (partial unique index) — a duplicate surfaces as IMEI_ACTIVE.
 *  - Every status change takes `SELECT … FOR UPDATE` on the request, so two admins (or an admin
 *    and a vendor) can never both win a race.
 *  - Vendors only see open requests and their own assigned ones, never other vendors' offers,
 *    and customer contact details stay masked until the request is assigned to them.
 *
 * @module modules/sell-requests/sell-requests.service
 */

import { getClient, query } from '../../config/database.js'
import { notifySellEvent } from './sell-requests.notify.js'
import { DEFAULT_RULES, ValidationError, isValidImei, parseQa, valuate, variantBase } from './valuation.js'
import { claimMedia, listMedia } from './evidence.service.js'
import { assertQcAllowsApproval, assertQcAllowsCompletion, ensureQc, getQc } from './request-qc.service.js'

export class SellError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message)
    this.name = 'SellError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

const TYPES = ['SELL_TO_AB', 'BUY_NOW', 'EXCHANGE']
const OPEN = ['PENDING', 'IN_PROGRESS']
const TAB_STATUS = {
  pending: ['PENDING'],
  progress: ['IN_PROGRESS'],
  completed: ['COMPLETED'],
  cancelled: ['CANCELLED'],
}
const num = (v) => (v == null ? null : Number(v))
/** SELL and EXCHANGE are separate sections — every query is scoped to one. */
export const KINDS = Object.freeze({
  SELL: { types: ['SELL_TO_AB', 'BUY_NOW'], prefix: 'SELL', seq: 'sell_request_seq', noun: 'sell request' },
  EXCHANGE: { types: ['EXCHANGE'], prefix: 'EXCH', seq: 'exchange_request_seq', noun: 'exchange request' },
})
const kindOfType = (type) => (type === 'EXCHANGE' ? 'EXCHANGE' : 'SELL')
const scopeKindOf = (actor) => {
  if (!KINDS[actor?.scopeKind]) throw new Error('actor.scopeKind (SELL | EXCHANGE) is required')
  return actor.scopeKind
}

const PHONE_RE = /^\+?\d[\d ]{9,13}$/

/** Run `fn(client)` inside a transaction. */
export async function tx(fn) {
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

export async function addEvent(client, requestId, kind, label, actor, meta = {}) {
  await client.query(
    `INSERT INTO sell_request_events (request_id, kind, label, actor_id, actor_role, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
    [requestId, kind, label, actor?.userId || null, actor?.kind || null, meta]
  )
}

// ── Settings & catalogue ────────────────────────────────────────────────

export async function getSettings(client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run('SELECT * FROM sell_settings WHERE id = TRUE')
  if (!rows[0]) throw new SellError('SETTINGS_MISSING', 'Sell settings are not initialised', 500)
  return rows[0]
}

export async function getSettingsForAdmin() {
  const s = await getSettings()
  return {
    enabled: s.enabled,
    rules: { ...DEFAULT_RULES, ...s.rules },
    defaultRules: DEFAULT_RULES,
    maxTotalDeductionPct: num(s.max_total_deduction_pct),
    variantStepPct: num(s.variant_step_pct),
    maxImages: s.max_images,
    maxVideos: s.max_videos,
    maxImageMb: s.max_image_mb,
    maxVideoMb: s.max_video_mb,
    qcRequiredForApproval: s.qc_required_for_approval,
  }
}

export async function updateSettings(actor, input) {
  const patch = {}
  if (input.rules !== undefined) {
    if (typeof input.rules !== 'object' || input.rules === null) throw new SellError('VALIDATION', 'rules must be an object', 422)
    for (const [k, v] of Object.entries(input.rules)) {
      if (!(k in DEFAULT_RULES)) throw new SellError('VALIDATION', `Unknown rule "${k}"`, 422)
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) throw new SellError('VALIDATION', `Rule "${k}" must be a non-negative number`, 422)
      patch[k] = v
    }
  }
  const pct = (v, name) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new SellError('VALIDATION', `${name} must be 0–100`, 422)
    return n
  }
  const cur = await getSettings()
  const int = (v, name, lo, hi, fallback) => {
    if (v === undefined) return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < lo || n > hi) throw new SellError('VALIDATION', `${name} must be a whole number from ${lo} to ${hi}`, 422)
    return n
  }
  const maxImages = int(input.maxImages, 'maxImages', 0, 20, cur.max_images)
  const maxVideos = int(input.maxVideos, 'maxVideos', 0, 5, cur.max_videos)
  const maxImageMb = int(input.maxImageMb, 'maxImageMb', 1, 25, cur.max_image_mb)
  const maxVideoMb = int(input.maxVideoMb, 'maxVideoMb', 5, 500, cur.max_video_mb)
  if (input.qcRequiredForApproval !== undefined && typeof input.qcRequiredForApproval !== 'boolean') throw new SellError('VALIDATION', 'qcRequiredForApproval must be true or false', 422)
  await query(
    `UPDATE sell_settings SET enabled = $1, rules = $2, max_total_deduction_pct = $3, variant_step_pct = $4,
            max_images = $5, updated_by = $6, updated_at = NOW(),
            max_videos = $7, max_image_mb = $8, max_video_mb = $9, qc_required_for_approval = $10 WHERE id = TRUE`,
    [
      input.enabled ?? cur.enabled,
      input.rules !== undefined ? patch : cur.rules,
      input.maxTotalDeductionPct !== undefined ? pct(input.maxTotalDeductionPct, 'maxTotalDeductionPct') : cur.max_total_deduction_pct,
      input.variantStepPct !== undefined ? pct(input.variantStepPct, 'variantStepPct') : cur.variant_step_pct,
      maxImages,
      actor.userId,
      maxVideos, maxImageMb, maxVideoMb,
      input.qcRequiredForApproval ?? cur.qc_required_for_approval,
    ]
  )
  return getSettingsForAdmin()
}

const serializeModel = (m) => ({
  id: m.id, name: m.name, category: m.category, variants: m.variants, colors: m.colors,
  basePrice: num(m.base_price), isActive: m.is_active,
  brand: m.brand || null, brandLogoUrl: m.brand_logo_url || null, imageUrl: m.image_url || null,
})

export async function listModels({ includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM sell_device_models ${includeInactive ? '' : 'WHERE is_active = TRUE'} ORDER BY (category <> 'Smartphone'), category, name`
  )
  return rows.map(serializeModel)
}

/** Guest-safe teaser for the "Exchange & Save More" card: on/off + the highest base value of any accepted smartphone. */
export async function publicSummary() {
  const settings = await getSettings()
  const { rows } = await query(`SELECT MAX(base_price) AS max_value, COUNT(*)::int AS models FROM sell_device_models WHERE is_active = TRUE AND category = 'Smartphone'`)
  return { enabled: !!settings.enabled && rows[0].models > 0, maxValue: num(rows[0].max_value) ?? 0 }
}

function parseModelInput(input, base = {}) {
  const name = String(input.name ?? base.name ?? '').trim()
  const category = input.category ?? base.category
  const variants = input.variants ?? base.variants
  const colors = input.colors ?? base.colors
  const basePrice = Number(input.basePrice ?? base.base_price)
  if (!name) throw new SellError('VALIDATION', 'Model name is required', 422)
  if (!['Smartphone', 'Tablet', 'Laptop'].includes(category)) throw new SellError('VALIDATION', 'Invalid category', 422)
  const strs = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.trim()) && new Set(a).size === a.length
  if (!strs(variants)) throw new SellError('VALIDATION', 'Variants must be a non-empty list of unique names', 422)
  if (!strs(colors)) throw new SellError('VALIDATION', 'Colors must be a non-empty list of unique names', 422)
  if (!Number.isFinite(basePrice) || basePrice <= 0) throw new SellError('VALIDATION', 'Base price must be greater than zero', 422)
  const opt = (v, b) => { const x = v === undefined ? b : v; return x == null || x === '' ? null : String(x).trim().slice(0, 500) }
  return {
    name, category, variants, colors, basePrice,
    brand: opt(input.brand, base.brand), brandLogoUrl: opt(input.brandLogoUrl, base.brand_logo_url), imageUrl: opt(input.imageUrl, base.image_url),
  }
}

export async function createModel(input) {
  const m = parseModelInput(input)
  try {
    const { rows } = await query(
      `INSERT INTO sell_device_models (name, category, variants, colors, base_price, brand, brand_logo_url, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [m.name, m.category, JSON.stringify(m.variants), JSON.stringify(m.colors), m.basePrice, m.brand, m.brandLogoUrl, m.imageUrl]
    )
    return serializeModel(rows[0])
  } catch (err) {
    if (err.code === '23505') throw new SellError('MODEL_EXISTS', 'A model with this name already exists', 409)
    throw err
  }
}

export async function updateModel(id, input) {
  const { rows: cur } = await query('SELECT * FROM sell_device_models WHERE id = $1', [id])
  if (!cur[0]) throw new SellError('NOT_FOUND', 'Model not found', 404)
  const m = parseModelInput(input, cur[0])
  try {
    const { rows } = await query(
      `UPDATE sell_device_models SET name=$2, category=$3, variants=$4, colors=$5, base_price=$6,
              brand=$8, brand_logo_url=$9, image_url=$10,
              is_active = COALESCE($7, is_active), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, m.name, m.category, JSON.stringify(m.variants), JSON.stringify(m.colors), m.basePrice, typeof input.isActive === 'boolean' ? input.isActive : null, m.brand, m.brandLogoUrl, m.imageUrl]
    )
    return serializeModel(rows[0])
  } catch (err) {
    if (err.code === '23505') throw new SellError('MODEL_EXISTS', 'A model with this name already exists', 409)
    throw err
  }
}

// ── Valuation ───────────────────────────────────────────────────────────

async function resolveModel(input, client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run(
    `SELECT * FROM sell_device_models WHERE is_active = TRUE AND (id::text = $1 OR name = $1) LIMIT 1`,
    [String(input.modelId ?? input.model ?? '')]
  )
  if (!rows[0]) throw new SellError('MODEL_NOT_FOUND', 'This device model is not accepted', 404)
  return rows[0]
}

/** Quote without persisting — used by the customer app before submitting. */
export async function quote(input, client = null) {
  try {
    const settings = await getSettings(client)
    if (!settings.enabled) throw new SellError('DISABLED', 'Selling is currently disabled', 403)
    const model = await resolveModel(input, client)
    if (!model.colors.includes(input.color)) throw new SellError('VALIDATION', 'Unknown colour for this model', 422)
    const qa = parseQa(input.qa)
    const base = variantBase(model.base_price, model.variants, input.variant, num(settings.variant_step_pct))
    const v = valuate(base, qa, settings.rules, num(settings.max_total_deduction_pct))
    return { model, qa, base, settings, ...v }
  } catch (err) {
    if (err instanceof ValidationError) throw new SellError('VALIDATION', err.message, 422)
    throw err
  }
}

// ── Serialisation ───────────────────────────────────────────────────────

const maskPhone = (p) => `${p.slice(0, 3)} ••••• ••${p.slice(-3)}`
const maskName = (n) => { const [f, ...rest] = n.split(' '); return rest.length ? `${f} ${rest[rest.length - 1][0]}.` : f }

const STEP_ORDER = ['VENDOR_ASSIGNED', 'APPROVED', 'COMPLETED']
const STEP_LABEL = { VENDOR_ASSIGNED: 'Vendor Assigned', APPROVED: 'Approved', COMPLETED: 'Completed' }

function buildTimeline(status, events) {
  const out = events.map((e) => ({ label: e.label, at: e.created_at.toISOString(), done: true }))
  if (OPEN.includes(status) || status === 'APPROVED') {
    const seen = new Set(events.map((e) => e.kind))
    for (const k of STEP_ORDER) if (!seen.has(k)) out.push({ label: STEP_LABEL[k], at: '', done: false })
  }
  return out
}

/**
 * @param {object} r      sell_requests row (+ total_requests)
 * @param {object} opts   { actor, offers, events, assignedVendorName }
 */
function serialize(r, { actor = { kind: 'ADMIN' }, offers = [], events = [], assignedVendorName = null } = {}) {
  const masked = actor.kind === 'VENDOR' && r.assigned_vendor_id !== actor.vendorId
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    status: r.status,
    type: r.type,
    createdAt: r.created_at.toISOString(),
    customer: {
      name: masked ? maskName(r.customer_name) : r.customer_name,
      phone: masked ? maskPhone(r.customer_phone) : r.customer_phone,
      email: masked ? '' : r.customer_email || '',
      city: r.customer_city || '—',
      totalRequests: Number(r.total_requests ?? 1),
    },
    device: { model: r.model_name, variant: r.variant, color: r.color, category: r.category, imei: r.imei },
    condition: r.condition,
    qa: r.qa,
    description: r.description,
    imageCount: r.images.length + Number(r.media_images || 0),
    videoCount: Number(r.media_videos || 0),
    images: r.images,
    expectedPrice: num(r.expected_price),
    quote: num(r.quote),
    deductions: r.deductions,
    finalPrice: num(r.final_price),
    offers,
    assignedVendor: assignedVendorName,
    exchange: r.exchange || undefined,
    exchangeOrder: r.exchange_order_id ? { id: r.exchange_order_id, orderNumber: r.exchange_order_number, status: r.exchange_order_status, total: num(r.exchange_order_total), linkedAt: r.exchange_linked_at?.toISOString() ?? null } : null,
    timeline: buildTimeline(r.status, events),
    adminNote: actor.kind === 'VENDOR' ? undefined : r.admin_note || undefined,
  }
}

const serializeOffer = (o) => ({
  vendorId: o.vendor_id,
  vendorName: o.vendor_name,
  city: o.city || '—',
  rating: Number(o.rating || 0),
  distanceKm: num(o.distance_km) ?? 0,
  amount: num(o.amount),
  note: o.note || undefined,
  status: o.status === 'WITHDRAWN' ? 'DECLINED' : o.status,
})

const SELECT_REQ = `
  SELECT r.*, (SELECT COUNT(*) FROM sell_requests x WHERE x.customer_phone = r.customer_phone) AS total_requests,
         (SELECT COUNT(*) FROM sell_request_media m WHERE m.entity_id = r.id AND m.media_type = 'IMAGE') AS media_images,
         (SELECT COUNT(*) FROM sell_request_media m WHERE m.entity_id = r.id AND m.media_type = 'VIDEO') AS media_videos,
         v.name AS assigned_vendor_name,
         o.order_number AS exchange_order_number, o.status::text AS exchange_order_status, o.total_payable AS exchange_order_total
    FROM sell_requests r LEFT JOIN vendors v ON v.id = r.assigned_vendor_id
    LEFT JOIN orders o ON o.id = r.exchange_order_id`

async function loadOffers(requestId, actor) {
  const { rows } = await query(
    `SELECT o.*, v.name AS vendor_name, s.city, s.rating
       FROM sell_request_offers o
       JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN LATERAL (SELECT MIN(city) AS city, COALESCE(MAX(seller_rating), 0) AS rating
                            FROM shops WHERE vendor_id = o.vendor_id AND deleted_at IS NULL) s ON TRUE
      WHERE o.request_id = $1 AND o.status <> 'WITHDRAWN' ${actor.kind === 'VENDOR' ? 'AND o.vendor_id = $2' : ''}
      ORDER BY o.amount DESC, o.created_at`,
    actor.kind === 'VENDOR' ? [requestId, actor.vendorId] : [requestId]
  )
  return rows.map(serializeOffer)
}

async function loadEvents(requestId) {
  const { rows } = await query('SELECT kind, label, created_at FROM sell_request_events WHERE request_id = $1 ORDER BY id', [requestId])
  return rows
}

/** Visibility predicate, appended to WHERE with `params` mutated for any new binds. */
export function scope(actor, params) {
  params.push(scopeKindOf(actor))
  const sectionSql = `r.kind = $${params.length}`
  if (actor.kind !== 'VENDOR') return sectionSql
  params.push(actor.vendorId)
  return `${sectionSql} AND (r.assigned_vendor_id = $${params.length} OR (r.assigned_vendor_id IS NULL AND r.status = ANY('{PENDING,IN_PROGRESS}')))`
}

export async function fetchOne(actor, id) {
  const params = [id]
  const sc = scope(actor, params)
  const { rows } = await query(`${SELECT_REQ} WHERE r.id = $1 AND ${sc}`, params)
  if (!rows[0]) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  return rows[0]
}

export async function getManage(actor, id) {
  const r = await fetchOne(actor, id)
  const [offers, events, media, qc] = await Promise.all([loadOffers(id, actor), loadEvents(id), listMedia(id), getQc(id)])
  const out = serialize(r, { actor, offers, events, assignedVendorName: r.assigned_vendor_name })
  out.media = media
  // Vendors see the evidence but not the platform's internal QC notes.
  out.qc = actor.kind === 'VENDOR' ? { status: qc.status } : qc
  return out
}

// ── Listing & stats ─────────────────────────────────────────────────────

export async function listManage(actor, f = {}) {
  const params = []
  const where = [scope(actor, params)]
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }
  if (f.category && f.category !== 'all') add('r.category = ?', f.category)
  if (f.condition && f.condition !== 'all') add('r.condition = ?', f.condition)
  if (f.type && f.type !== 'all') add('r.type = ?', f.type)
  if (f.q) {
    params.push(`%${f.q}%`)
    where.push(`((r.code || ' ' || r.model_name || ' ' || r.customer_name || ' ' || r.imei) ILIKE $${params.length} OR r.customer_phone ILIKE $${params.length})`)
  }
  const baseWhere = where.join(' AND ')

  const { rows: cnt } = await query(
    `SELECT r.status, COUNT(*)::int AS n FROM sell_requests r WHERE ${baseWhere} GROUP BY r.status`, params
  )
  const byStatus = Object.fromEntries(cnt.map((c) => [c.status, c.n]))
  const counts = { all: cnt.reduce((n, c) => n + c.n, 0) }
  for (const [tab, sts] of Object.entries(TAB_STATUS)) counts[tab] = sts.reduce((n, s) => n + (byStatus[s] || 0), 0)

  const tab = f.status && f.status !== 'all' ? TAB_STATUS[f.status] : null
  if (f.status && f.status !== 'all' && !tab) throw new SellError('VALIDATION', 'Unknown status tab', 422)
  const total = tab ? counts[f.status] : counts.all
  const limit = Math.min(100, Math.max(1, Number(f.limit) || 14))
  const pages = Math.max(1, Math.ceil(total / limit))
  const page = Math.min(Math.max(1, Number(f.page) || 1), pages)

  const listParams = [...params]
  let statusSql = ''
  if (tab) { listParams.push(tab); statusSql = ` AND r.status = ANY($${listParams.length})` }
  listParams.push(limit, (page - 1) * limit)
  const { rows } = await query(
    `${SELECT_REQ} WHERE ${baseWhere}${statusSql} ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams
  )
  return {
    success: true,
    data: {
      items: rows.map((r) => serialize(r, { actor, assignedVendorName: r.assigned_vendor_name })),
      total, page, pages, counts,
    },
  }
}

const pctChange = (cur, prev) => (prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 1000) / 10)

export async function stats(actor) {
  const params = []
  const sc = scope(actor, params)
  const { rows } = await query(
    `SELECT r.status,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '7 days')::int AS cur,
            COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '14 days' AND r.created_at < NOW() - INTERVAL '7 days')::int AS prev
       FROM sell_requests r WHERE ${sc} GROUP BY r.status`, params
  )
  const agg = (sts) => rows.filter((x) => !sts || sts.includes(x.status)).reduce((a, x) => ({ total: a.total + x.total, cur: a.cur + x.cur, prev: a.prev + x.prev }), { total: 0, cur: 0, prev: 0 })
  const t = agg(null), p = agg(['PENDING']), a = agg(['APPROVED']), rj = agg(['REJECTED']), c = agg(['COMPLETED'])
  const { rows: x } = await query(
    `SELECT COALESCE(SUM(r.quote) FILTER (WHERE r.status IN ('APPROVED','COMPLETED')), 0) AS value,
            COUNT(*) FILTER (WHERE r.status IN ('PENDING','IN_PROGRESS','APPROVED') AND r.exchange_order_id IS NULL)::int AS awaiting_order
       FROM sell_requests r WHERE ${sc}`, params
  )
  return {
    approvedValue: Number(x[0].value),
    awaitingOrder: scopeKindOf(actor) === 'EXCHANGE' ? x[0].awaiting_order : undefined,
    total: t.total, pending: p.total, approved: a.total, rejected: rj.total, completed: c.total,
    trend: { total: pctChange(t.cur, t.prev), pending: pctChange(p.cur, p.prev), approved: pctChange(a.cur, a.prev), rejected: pctChange(rj.cur, rj.prev), completed: pctChange(c.cur, c.prev) },
  }
}

// ── Create ──────────────────────────────────────────────────────────────

/** Only images served by our own upload endpoint (local disk or the configured Cloudinary cloud). */
async function trustedPrefixes() {
  const { PUBLIC_BASE } = await import('../uploads/local-uploads.routes.js')
  const prefixes = [`${PUBLIC_BASE}/`]
  const cloud = process.env.CLOUDINARY_CLOUD_NAME
  if (cloud) prefixes.push(`https://res.cloudinary.com/${cloud}/`)
  return prefixes
}

async function cleanImages(images, max) {
  if (images == null) return []
  if (!Array.isArray(images) || images.length > max) throw new SellError('VALIDATION', `Up to ${max} images are allowed`, 422)
  const prefixes = await trustedPrefixes()
  for (const u of images) {
    if (typeof u !== 'string' || u.length > 500 || !prefixes.some((p) => u.startsWith(p)) || u.includes('..')) {
      throw new SellError('VALIDATION', 'Images must be uploaded through the Dealker upload endpoint', 422)
    }
  }
  return [...new Set(images)]
}

/**
 * @param {{kind:'CUSTOMER'|'ADMIN', userId:string}} actor
 */
export async function createRequest(actor, input) {
  if (!TYPES.includes(input.type)) throw new SellError('VALIDATION', 'Invalid request type', 422)
  const section = KINDS[scopeKindOf(actor)]
  if (!section.types.includes(input.type)) {
    throw new SellError('WRONG_SECTION', section.prefix === 'SELL'
      ? 'Exchanges are created from the Exchange section — use /exchange-requests'
      : 'Sell requests are created from the Sell section — use /sell-requests', 422)
  }
  if (!isValidImei(input.imei)) throw new SellError('INVALID_IMEI', 'IMEI must be 15 digits and pass the checksum', 422)

  let customer
  if (actor.kind === 'CUSTOMER') {
    const { rows } = await query('SELECT id, name, phone, email FROM users WHERE id = $1 AND is_active = TRUE', [actor.userId])
    if (!rows[0]) throw new SellError('UNAUTHORIZED', 'Account not found', 401)
    customer = { userId: rows[0].id, name: rows[0].name || 'Customer', phone: rows[0].phone, email: rows[0].email, city: input.customer?.city || null }
  } else {
    const c = input.customer || {}
    if (!String(c.name || '').trim()) throw new SellError('VALIDATION', 'Customer name is required', 422)
    if (!PHONE_RE.test(String(c.phone || '').trim())) throw new SellError('VALIDATION', 'Customer phone is invalid', 422)
    const phone = String(c.phone).trim()
    const { rows } = await query('SELECT id FROM users WHERE phone = $1 OR phone = $2 LIMIT 1', [phone, phone.replace(/\D/g, '').slice(-10)])
    customer = { userId: rows[0]?.id || null, name: String(c.name).trim().slice(0, 100), phone, email: c.email || null, city: c.city || null }
  }

  let exchangeIn = null
  if (input.type === 'EXCHANGE') {
    const e = input.exchange || {}
    const price = Number(e.newProductPrice)
    if (!String(e.newProduct || '').trim() || !Number.isFinite(price) || price <= 0) throw new SellError('VALIDATION', 'Exchange needs the new product and its price', 422)
    exchangeIn = { newProduct: String(e.newProduct).trim().slice(0, 200), newProductPrice: price }
  }

  const description = String(input.description || '').slice(0, 1000)

  let created = null
  try {
    const out = await tx(async (client) => {
      const q = await quote(input, client)
      const images = await cleanImages(input.images, q.settings.max_images)
      const expected = input.expectedPrice == null || input.expectedPrice === '' ? q.value : Number(input.expectedPrice)
      if (!Number.isFinite(expected) || expected < 0) throw new SellError('VALIDATION', 'Expected price is invalid', 422)
      const exchange = exchangeIn
        ? { ...exchangeIn, tradeInValue: q.value, payable: Math.max(0, exchangeIn.newProductPrice - q.value) }
        : null

      const { rows } = await client.query(
        `INSERT INTO sell_requests (code, type, user_id, customer_name, customer_phone, customer_email, customer_city,
            created_by, created_by_role, model_id, model_name, variant, color, category, imei, qa, condition, base_price,
            quote, deductions, expected_price, description, images, exchange)
         VALUES ('${section.prefix}-' || nextval('${section.seq}'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [input.type, customer.userId, customer.name, customer.phone, customer.email, customer.city, actor.userId, actor.kind,
          q.model.id, q.model.name, input.variant, input.color, q.model.category, input.imei, q.qa, q.condition, q.base,
          q.value, JSON.stringify(q.deductions), expected, description, JSON.stringify(images), exchange ? JSON.stringify(exchange) : null]
      )
      await addEvent(client, rows[0].id, 'SUBMITTED', input.type === 'EXCHANGE' ? 'Exchange Submitted' : 'Request Submitted', actor)
      if (input.type === 'EXCHANGE' && String(input.orderNumber ?? '').trim()) {
        // The customer already placed the order for the new phone — link it up front.
        const o = await findLinkableOrder(client, String(input.orderNumber).trim(), customer.userId)
        await client.query(`UPDATE sell_requests SET exchange_order_id=$2, exchange_linked_at=NOW(), exchange_linked_by=$3 WHERE id=$1`, [rows[0].id, o.id, actor.userId])
        await addEvent(client, rows[0].id, 'ORDER_LINKED', `Order ${o.order_number} linked`, actor, { orderId: o.id })
      }
      created = rows[0].id
      await ensureQc(client, rows[0].id, actor)
      if (Array.isArray(input.mediaIds) && input.mediaIds.length) await claimMedia(client, rows[0], actor, input.mediaIds, 'CUSTOMER_SUBMISSION')
      const full = { ...rows[0], total_requests: 1 }
      return full
    }).then(async (full) => getManage({ kind: 'ADMIN', scopeKind: full.kind }, full.id))
    notifySellEvent('SUBMITTED', created)
    return out
  } catch (err) {
    if (err.code === '23505' && String(err.constraint).includes('active_imei')) {
      throw new SellError('IMEI_ACTIVE', 'A live request already exists for this IMEI', 409)
    }
    if (err.code === '23505' && String(err.constraint).includes('exchange_order')) {
      throw new SellError('ORDER_ALREADY_LINKED', 'That order is already linked to another trade-in', 409)
    }
    throw err
  }
}

// ── Customer reads ──────────────────────────────────────────────────────

export async function mine(userId, kind, { page = 1, limit = 20 } = {}) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 20))
  const off = (Math.max(1, Number(page)) - 1) * lim
  const { rows } = await query(`${SELECT_REQ} WHERE r.user_id = $1 AND r.kind = $4 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [userId, lim, off, kind])
  const { rows: c } = await query('SELECT COUNT(*)::int AS n FROM sell_requests WHERE user_id = $1 AND kind = $2', [userId, kind])
  return { success: true, data: { items: rows.map((r) => serialize(r, { assignedVendorName: null })), total: c[0].n } }
}

export async function getMine(userId, id, kind) {
  const { rows } = await query(`${SELECT_REQ} WHERE r.id = $1 AND r.user_id = $2 AND r.kind = $3`, [id, userId, kind])
  if (!rows[0]) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  const events = await loadEvents(id)
  // Customers see the best open offer amount only — not which vendor made it.
  const { rows: best } = await query(
    `SELECT MAX(amount) AS best FROM sell_request_offers WHERE request_id = $1 AND status IN ('OPEN','ACCEPTED')`, [id]
  )
  const out = serialize(rows[0], { events })
  out.media = await listMedia(id)
  out.qc = await getQc(id, { forCustomer: true })
  out.bestOffer = num(best[0].best)
  delete out.adminNote
  return out
}

// ── State transitions ───────────────────────────────────────────────────

export async function lock(client, id, actor) {
  const { rows } = await client.query('SELECT * FROM sell_requests WHERE id = $1 FOR UPDATE', [id])
  // A request from the other section is invisible here, exactly as if it did not exist.
  if (!rows[0] || rows[0].kind !== scopeKindOf(actor)) {
    throw new SellError('NOT_FOUND', `${scopeKindOf(actor) === 'EXCHANGE' ? 'Exchange' : 'Sell'} request not found`, 404)
  }
  return rows[0]
}

const need = (r, allowed, msg) => {
  if (!allowed.includes(r.status)) throw new SellError('INVALID_STATE', msg || `Request is ${r.status.toLowerCase().replace('_', ' ')}`, 409)
}

const noteOf = (v, { required = false, name = 'A note' } = {}) => {
  const s = String(v ?? '').trim().slice(0, 500)
  if (required && !s) throw new SellError('VALIDATION', `${name} is required`, 422)
  return s
}

export const approve = (actor, id) => tx(async (client) => {
  const r = await lock(client, id, actor)
  need(r, OPEN, 'Only pending or in-progress requests can be approved')
  if (!r.assigned_vendor_id) throw new SellError('NO_VENDOR', 'Assign a vendor offer before approving', 409)
  await assertQcAllowsApproval(client, id)
  await client.query(`UPDATE sell_requests SET status='APPROVED', decided_by=$2, decided_at=NOW(), updated_at=NOW() WHERE id=$1`, [id, actor.userId])
  await addEvent(client, id, 'APPROVED', 'Approved', actor)
}).then(() => { notifySellEvent('APPROVED', id); return getManage(actor, id) })

export const reject = (actor, id, reason) => tx(async (client) => {
  const note = noteOf(reason, { required: true, name: 'A reason' })
  const r = await lock(client, id, actor)
  need(r, OPEN, 'Only pending or in-progress requests can be rejected')
  await client.query(`UPDATE sell_requests SET status='REJECTED', admin_note=$2, decided_by=$3, decided_at=NOW(), updated_at=NOW() WHERE id=$1`, [id, note, actor.userId])
  await client.query(`UPDATE sell_request_offers SET status='DECLINED', updated_at=NOW() WHERE request_id=$1 AND status='OPEN'`, [id])
  await addEvent(client, id, 'REJECTED', 'Rejected', actor, { reason: note })
  return note
}).then((note) => { notifySellEvent('REJECTED', id, { reason: note }); return getManage(actor, id) })

export const requestInfo = (actor, id, message) => tx(async (client) => {
  const note = noteOf(message, { required: true, name: 'A message' })
  const r = await lock(client, id, actor)
  need(r, OPEN, 'Details can only be requested on open requests')
  await client.query(`UPDATE sell_requests SET admin_note=$2, updated_at=NOW() WHERE id=$1`, [id, note])
  await addEvent(client, id, 'INFO_REQUESTED', 'More details requested from customer', actor, { message: note })
  return note
}).then((note) => { notifySellEvent('INFO_REQUESTED', id, { message: note }); return getManage(actor, id) })

export const complete = (actor, id) => tx(async (client) => {
  const r = await lock(client, id, actor)
  need(r, ['APPROVED'], 'Only approved requests can be completed')
  if (r.type === 'EXCHANGE' && !r.exchange_order_id) {
    throw new SellError('EXCHANGE_ORDER_REQUIRED', 'Link the order for the new product before completing an exchange', 409)
  }
  await assertQcAllowsCompletion(client, id)
  await client.query(`UPDATE sell_requests SET status='COMPLETED', updated_at=NOW() WHERE id=$1`, [id])
  await addEvent(client, id, 'COMPLETED', 'Completed', actor)
}).then(() => { notifySellEvent('COMPLETED', id); return getManage(actor, id) })

/** Find the order for the new product and check it can settle this customer's trade-in. */
async function findLinkableOrder(client, key, userId) {
  if (!userId) throw new SellError('NO_CUSTOMER_ACCOUNT', 'This customer has no app account, so an order cannot be linked', 409)
  const { rows } = await client.query(
    `SELECT id, customer_id AS user_id, status::text AS status, order_number FROM orders WHERE order_number = $1 OR id::text = $1 LIMIT 1`, [key]
  )
  const o = rows[0]
  if (!o) throw new SellError('ORDER_NOT_FOUND', 'Order not found', 404)
  if (o.user_id !== userId) throw new SellError('ORDER_MISMATCH', 'That order belongs to a different customer', 409)
  if (o.status === 'CANCELLED') throw new SellError('ORDER_CANCELLED', 'That order is cancelled', 409)
  return o
}

/**
 * Link the order for the new product to an EXCHANGE request (by order number or id).
 * The order must belong to the same customer and not be cancelled; one order settles one trade-in.
 */
export const linkOrder = (actor, id, ref) => tx(async (client) => {
  const key = String(ref ?? '').trim()
  if (!key) throw new SellError('VALIDATION', 'Order number is required', 422)
  const r = await lock(client, id, actor)
  if (r.type !== 'EXCHANGE') throw new SellError('INVALID_STATE', 'Only exchange requests can be linked to an order', 409)
  need(r, [...OPEN, 'APPROVED'], 'Only open or approved exchanges can be linked to an order')
  if (r.exchange_order_id) throw new SellError('ORDER_ALREADY_LINKED', 'This exchange already has an order linked', 409)
  const o = await findLinkableOrder(client, key, r.user_id)
  try {
    await client.query(`UPDATE sell_requests SET exchange_order_id=$2, exchange_linked_at=NOW(), exchange_linked_by=$3, updated_at=NOW() WHERE id=$1`, [id, o.id, actor.userId])
  } catch (err) {
    if (err.code === '23505') throw new SellError('ORDER_ALREADY_LINKED', 'That order is already linked to another trade-in', 409)
    throw err
  }
  await addEvent(client, id, 'ORDER_LINKED', `Order ${o.order_number} linked`, actor, { orderId: o.id })
}).then(() => { notifySellEvent('ORDER_LINKED', id); return getManage(actor, id) })

/** Admin cancels any open/approved request; a customer may cancel their own until it is approved. */
export const cancel = (actor, id, reason) => tx(async (client) => {
  const r = await lock(client, id, actor)
  if (actor.kind === 'CUSTOMER') {
    if (r.user_id !== actor.userId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
    need(r, OPEN, 'This request can no longer be cancelled')
  } else {
    need(r, [...OPEN, 'APPROVED'], 'Completed, rejected or cancelled requests cannot be cancelled')
  }
  await client.query(`UPDATE sell_requests SET status='CANCELLED', admin_note=COALESCE($2, admin_note), updated_at=NOW() WHERE id=$1`, [id, noteOf(reason) || null])
  await client.query(`UPDATE sell_request_offers SET status='DECLINED', updated_at=NOW() WHERE request_id=$1 AND status IN ('OPEN','ACCEPTED')`, [id])
  await addEvent(client, id, 'CANCELLED', actor.kind === 'CUSTOMER' ? 'Cancelled by customer' : 'Cancelled', actor)
}).then(() => { notifySellEvent('CANCELLED', id, { skipCustomer: actor.kind === 'CUSTOMER' }) }).then(() => (actor.kind === 'CUSTOMER' ? getMine(actor.userId, id, scopeKindOf(actor)) : getManage(actor, id)))

export const assignVendor = (actor, id, vendorId) => tx(async (client) => {
  const r = await lock(client, id, actor)
  need(r, OPEN, 'A vendor can only be assigned to open requests')
  const { rows } = await client.query(
    `SELECT o.*, v.name FROM sell_request_offers o JOIN vendors v ON v.id = o.vendor_id
      WHERE o.request_id = $1 AND o.vendor_id = $2 AND o.status = 'OPEN' FOR UPDATE OF o`, [id, vendorId]
  )
  if (!rows[0]) throw new SellError('OFFER_NOT_FOUND', 'That vendor has no open offer on this request', 404)
  const declined = await client.query(`SELECT vendor_id FROM sell_request_offers WHERE request_id = $1 AND vendor_id <> $2 AND status = 'OPEN'`, [id, vendorId])
  await client.query(`UPDATE sell_request_offers SET status = CASE WHEN vendor_id = $2 THEN 'ACCEPTED' ELSE 'DECLINED' END, updated_at = NOW()
                       WHERE request_id = $1 AND status IN ('OPEN','ACCEPTED')`, [id, vendorId])
  await client.query(`UPDATE sell_requests SET assigned_vendor_id=$2, final_price=$3, status='IN_PROGRESS', updated_at=NOW() WHERE id=$1`, [id, vendorId, rows[0].amount])
  await addEvent(client, id, 'VENDOR_ASSIGNED', `Vendor Assigned: ${rows[0].name}`, actor, { vendorId, amount: num(rows[0].amount) })
  return declined.rows.map((x) => x.vendor_id)
}).then((declinedVendorIds) => {
  notifySellEvent('VENDOR_ASSIGNED', id)
  if (declinedVendorIds.length) notifySellEvent('OFFER_DECLINED', id, { declinedVendorIds })
  return getManage(actor, id)
})

// ── Vendor offers ───────────────────────────────────────────────────────

export const placeOffer = (actor, id, input) => tx(async (client) => {
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new SellError('VALIDATION', 'Offer amount must be greater than zero', 422)
  const { rows: v } = await client.query(`SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE AND status IN ('VERIFIED','ACTIVE') AND deleted_at IS NULL`, [actor.vendorId])
  if (!v[0]) throw new SellError('VENDOR_NOT_ACTIVE', 'Only verified, active vendors can place offers', 403)
  const r = await lock(client, id, actor)
  need(r, OPEN, 'This request is no longer open for offers')
  if (r.assigned_vendor_id) throw new SellError('ALREADY_ASSIGNED', 'A vendor has already been assigned', 409)
  if (amount > Number(r.base_price) * 1.25) throw new SellError('VALIDATION', 'Offer is unrealistically high for this device', 422)
  const distance = input.distanceKm == null ? null : Math.max(0, Math.min(999, Number(input.distanceKm) || 0))
  const { rows: ex } = await client.query('SELECT id, status FROM sell_request_offers WHERE request_id=$1 AND vendor_id=$2 FOR UPDATE', [id, actor.vendorId])
  if (ex[0]) {
    await client.query(`UPDATE sell_request_offers SET amount=$2, note=$3, distance_km=COALESCE($4, distance_km), status='OPEN', updated_at=NOW() WHERE id=$1`, [ex[0].id, amount, noteOf(input.note) || null, distance])
  } else {
    await client.query(`INSERT INTO sell_request_offers (request_id, vendor_id, amount, note, distance_km) VALUES ($1,$2,$3,$4,$5)`, [id, actor.vendorId, amount, noteOf(input.note) || null, distance])
    await addEvent(client, id, 'QUOTE_RECEIVED', 'Quote Received', actor, { vendorId: actor.vendorId })
  }
}).then(() => getManage(actor, id))

export const withdrawOffer = (actor, id) => tx(async (client) => {
  const r = await lock(client, id, actor)
  need(r, OPEN, 'This request is no longer open')
  if (r.assigned_vendor_id === actor.vendorId) throw new SellError('ALREADY_ASSIGNED', 'You are already assigned — ask an admin to cancel', 409)
  const { rowCount } = await client.query(`UPDATE sell_request_offers SET status='WITHDRAWN', updated_at=NOW() WHERE request_id=$1 AND vendor_id=$2 AND status='OPEN'`, [id, actor.vendorId])
  if (!rowCount) throw new SellError('OFFER_NOT_FOUND', 'You have no open offer on this request', 404)
}).then(() => getManage(actor, id))
