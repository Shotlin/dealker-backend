/**
 * Repair marketplace — vendors price their repair services, nearby vendors quote on a customer's request,
 * the customer compares offers and picks one (pickup & delivery or a shop visit), then the normal repair
 * lifecycle (repairs.service) takes over.
 *
 * Invariants
 *  - Prices are computed here from vendor price-list rows or validated lines; a client never sends a total.
 *  - A vendor sees an open request only while it is in range of one of its shops, and only an anonymised view
 *    (first name, area, device, issues, photos) — phone and address are released once the customer selects it.
 *  - Selecting an offer is one transaction: request row locked, offer row locked, every other offer closed.
 *  - One live offer per vendor per request; automatic offers never overwrite a vendor's hand-written one.
 *  - No live location: pickup/delivery progress is status events only (optionally a courier name / tracking link).
 *
 * @module modules/repairs/repairs.market
 */
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { haversineKm } from '../../utils/distance.js'
import { advanceFor, computeQuote, money, TABS } from './repairs.engine.js'
import { notifyRepair } from './repairs.notify.js'
import {
  CATEGORIES, PROBLEMS, RepairError, addEvent, getManage, getSettings, lock, moveTo, num, patch, text, tx,
} from './repairs.service.js'

const LINE_KINDS = ['LABOUR', 'PART', 'OTHER']
const FULFILMENT = ['PICKUP_DELIVERY', 'SHOP_VISIT']
const SORTS = ['best', 'nearest', 'lowest_price', 'highest_rating']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TITLES = {
  SCREEN: 'Display replacement', BATTERY: 'Battery replacement', CHARGING: 'Charging port repair', WATER_DAMAGE: 'Water damage treatment',
  SOFTWARE: 'Software repair', CAMERA: 'Camera repair', AUDIO: 'Speaker / microphone repair', BODY: 'Back panel / body repair',
  BOARD: 'Motherboard repair', BIOMETRIC: 'Fingerprint / face sensor repair', DATA: 'Data recovery', TOUCH: 'Touch repair',
  NETWORK: 'Network / SIM repair', OTHER: 'Other repair',
}

export const ISSUES = Object.entries(TITLES).map(([key, label]) => ({ key, label }))
export const DEVICE_TYPES = CATEGORIES

const price = (v, label) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000 || Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) {
    throw new RepairError('VALIDATION', `${label}: price must be between 0 and 10,00,000 with at most 2 decimals`, 422)
  }
  return Math.round(n * 100) / 100
}
const int = (v, label, min, max, dflt) => {
  if (v == null || v === '') return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new RepairError('VALIDATION', `${label} must be a whole number from ${min} to ${max}`, 422)
  return n
}

// ── vendor price list ───────────────────────────────────────────────────

const serializeService = (s) => ({
  id: s.id, vendorId: s.vendor_id, vendor: s.vendor_name ?? undefined, deviceCategory: s.device_category, brand: s.brand, model: s.model,
  problemCategory: s.problem_category, title: s.title, partsPrice: num(s.parts_price), labourPrice: num(s.labour_price),
  total: money.rupees(money.paise(s.parts_price) + money.paise(s.labour_price)),
  estDaysMin: s.est_days_min, estDaysMax: s.est_days_max, warrantyDays: s.warranty_days, pickupDelivery: s.pickup_delivery, isActive: s.is_active,
})

/** A service centre manages its own list; platform staff must name the vendor. */
function ownerVendor(actor, vendorId) {
  const id = actor.kind === 'VENDOR' ? actor.vendorId : vendorId
  if (!id || !UUID_RE.test(id)) throw new RepairError('VALIDATION', 'Choose a vendor', 422)
  return id
}

function cleanService(input, dflt = {}) {
  const deviceCategory = input.deviceCategory ?? dflt.device_category ?? 'Smartphone'
  if (!CATEGORIES.includes(deviceCategory)) throw new RepairError('VALIDATION', 'Unknown device type', 422)
  const brand = text(input.brand ?? dflt.brand, 60)
  if (!brand) throw new RepairError('VALIDATION', 'Brand is required', 422)
  const model = text(input.model ?? dflt.model, 120) || null
  const problemCategory = input.problemCategory ?? dflt.problem_category
  if (!PROBLEMS.includes(problemCategory)) throw new RepairError('VALIDATION', 'Choose the repair type', 422)
  const title = text(input.title ?? dflt.title, 120) || TITLES[problemCategory]
  const partsPrice = price(input.partsPrice ?? dflt.parts_price ?? 0, 'Parts')
  const labourPrice = price(input.labourPrice ?? dflt.labour_price ?? 0, 'Labour')
  if (partsPrice + labourPrice <= 0) throw new RepairError('VALIDATION', 'Set a price above zero', 422)
  const estDaysMin = int(input.estDaysMin ?? dflt.est_days_min, 'Minimum days', 0, 60, 1)
  const estDaysMax = int(input.estDaysMax ?? dflt.est_days_max, 'Maximum days', 0, 60, Math.max(estDaysMin, 2))
  if (estDaysMax < estDaysMin) throw new RepairError('VALIDATION', 'Maximum days cannot be below minimum days', 422)
  return {
    deviceCategory, brand, model, problemCategory, title, partsPrice, labourPrice, estDaysMin, estDaysMax,
    warrantyDays: int(input.warrantyDays ?? dflt.warranty_days, 'Warranty days', 0, 730, 90),
    pickupDelivery: input.pickupDelivery ?? dflt.pickup_delivery ?? true,
    isActive: input.isActive ?? dflt.is_active ?? true,
  }
}

export async function listServices(actor, f = {}) {
  const params = []
  const where = []
  if (actor.kind === 'VENDOR') { params.push(actor.vendorId); where.push(`s.vendor_id = $${params.length}`) }
  else if (f.vendorId && UUID_RE.test(f.vendorId)) { params.push(f.vendorId); where.push(`s.vendor_id = $${params.length}`) }
  if (f.brand) { params.push(String(f.brand).toLowerCase()); where.push(`lower(s.brand) = $${params.length}`) }
  if (f.active === 'true' || f.active === true) where.push('s.is_active')
  if (f.q) { params.push(`%${String(f.q).slice(0, 80)}%`); where.push(`(s.title ILIKE $${params.length} OR s.brand ILIKE $${params.length} OR s.model ILIKE $${params.length} OR v.name ILIKE $${params.length})`) }
  const { rows } = await query(
    `SELECT s.*, v.name AS vendor_name FROM repair_vendor_services s JOIN vendors v ON v.id = s.vendor_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.name, s.brand, s.model NULLS FIRST, s.problem_category LIMIT 1000`, params)
  return rows.map(serializeService)
}

async function assertVendor(vendorId) {
  const { rows } = await query(`SELECT id FROM vendors WHERE id = $1 AND deleted_at IS NULL AND is_active`, [vendorId])
  if (!rows[0]) throw new RepairError('VALIDATION', 'Vendor not found or inactive', 422)
}

const insertService = (vendorId, c) => query(
  `INSERT INTO repair_vendor_services (vendor_id, device_category, brand, model, problem_category, title, parts_price, labour_price, est_days_min, est_days_max, warranty_days, pickup_delivery, is_active)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
   ON CONFLICT (vendor_id, device_category, lower(brand), COALESCE(lower(model), ''), problem_category) DO UPDATE SET
     title = EXCLUDED.title, parts_price = EXCLUDED.parts_price, labour_price = EXCLUDED.labour_price, est_days_min = EXCLUDED.est_days_min,
     est_days_max = EXCLUDED.est_days_max, warranty_days = EXCLUDED.warranty_days, pickup_delivery = EXCLUDED.pickup_delivery, is_active = EXCLUDED.is_active, updated_at = NOW()
   RETURNING *`,
  [vendorId, c.deviceCategory, c.brand, c.model, c.problemCategory, c.title, c.partsPrice, c.labourPrice, c.estDaysMin, c.estDaysMax, c.warrantyDays, c.pickupDelivery, c.isActive])

/** Create (or update the same brand/model/issue) one row of the price list. */
export async function createService(actor, input = {}) {
  const vendorId = ownerVendor(actor, input.vendorId)
  await assertVendor(vendorId)
  const { rows } = await insertService(vendorId, cleanService(input))
  return serializeService(rows[0])
}

/** "Add Repair Service" screen: one device (brand + model) with several repair types priced at once. */
export async function saveServices(actor, input = {}) {
  const vendorId = ownerVendor(actor, input.vendorId)
  await assertVendor(vendorId)
  if (!Array.isArray(input.services) || !input.services.length) throw new RepairError('VALIDATION', 'Select at least one repair and price it', 422)
  if (input.services.length > 40) throw new RepairError('VALIDATION', 'At most 40 services per save', 422)
  const shared = { deviceCategory: input.deviceCategory, brand: input.brand, model: input.model, pickupDelivery: input.pickupDelivery, isActive: input.isActive }
  const clean = input.services.map((s) => cleanService({ ...shared, ...s }))
  const seen = new Set()
  for (const c of clean) {
    if (seen.has(c.problemCategory)) throw new RepairError('VALIDATION', `${TITLES[c.problemCategory]} is listed twice`, 422)
    seen.add(c.problemCategory)
  }
  const out = []
  for (const c of clean) out.push(serializeService((await insertService(vendorId, c)).rows[0]))
  return out
}

export async function updateService(actor, id, input = {}) {
  const { rows: cur } = await query('SELECT * FROM repair_vendor_services WHERE id = $1', [id])
  if (!cur[0] || (actor.kind === 'VENDOR' && cur[0].vendor_id !== actor.vendorId)) throw new RepairError('NOT_FOUND', 'Service not found', 404)
  const c = cleanService(input, cur[0])
  try {
    const { rows } = await query(
      `UPDATE repair_vendor_services SET device_category=$2, brand=$3, model=$4, problem_category=$5, title=$6, parts_price=$7, labour_price=$8,
              est_days_min=$9, est_days_max=$10, warranty_days=$11, pickup_delivery=$12, is_active=$13, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, c.deviceCategory, c.brand, c.model, c.problemCategory, c.title, c.partsPrice, c.labourPrice, c.estDaysMin, c.estDaysMax, c.warrantyDays, c.pickupDelivery, c.isActive])
    return serializeService(rows[0])
  } catch (err) {
    if (err.code === '23505') throw new RepairError('DUPLICATE', 'You already have a price for that brand, model and repair', 409)
    throw err
  }
}

export async function deleteService(actor, id) {
  const { rows } = await query('DELETE FROM repair_vendor_services WHERE id = $1 AND ($2::uuid IS NULL OR vendor_id = $2) RETURNING id', [id, actor.kind === 'VENDOR' ? actor.vendorId : null])
  if (!rows[0]) throw new RepairError('NOT_FOUND', 'Service not found', 404)
  return { deleted: true }
}

// ── who can quote: vendors with a shop near the customer ────────────────

/** Vendors that are live, with their shops. */
async function liveShops(vendorIds = null) {
  const { rows } = await query(
    `SELECT s.id AS shop_id, s.name AS shop_name, s.vendor_id, s.lat, s.lng, s.pincode, s.serviceable_pincodes, concat_ws(', ', s.address_line1, s.address_line2, s.city, s.state, s.pincode) AS address, v.name AS vendor_name
       FROM shops s JOIN vendors v ON v.id = s.vendor_id
      WHERE s.deleted_at IS NULL AND s.is_active AND s.warehouse_status = 'OPERATIONAL'
        AND v.deleted_at IS NULL AND v.is_active AND v.status IN ('VERIFIED','ACTIVE')
        AND COALESCE((SELECT p.accepting_requests FROM repair_vendor_profiles p WHERE p.vendor_id = s.vendor_id), TRUE)
        AND ($1::uuid[] IS NULL OR s.vendor_id = ANY($1))`, [vendorIds])
  return rows
}

/** Nearest in-range shop of a vendor for a request, or null when none is in range. */
function nearestShop(shops, req, radiusKm) {
  let best = null
  for (const sh of shops) {
    const km = haversineKm(req.customer_lat, req.customer_lng, sh.lat, sh.lng)
    const samePin = req.customer_pincode && (sh.pincode === req.customer_pincode || (sh.serviceable_pincodes || []).includes(req.customer_pincode))
    if (!samePin && (km == null || km > radiusKm)) continue
    const dist = km == null ? null : Math.round(km * 10) / 10
    if (!best || (dist != null && (best.distanceKm == null || dist < best.distanceKm))) best = { shop: sh, distanceKm: dist }
  }
  return best
}

// ── automatic ("live") quotes from price lists ──────────────────────────

/** Find the vendor's price for every issue of every device; null if any issue is not covered. */
function priceRequest(items, services) {
  const lines = []
  let daysMin = 0, daysMax = 0, warranty = Infinity, pickup = true
  for (const it of items) {
    const issues = it.problem_categories?.length ? it.problem_categories : [it.problem_category]
    for (const issue of issues) {
      const matches = services.filter((s) => s.device_category === it.category && s.problem_category === issue && s.brand.toLowerCase() === it.brand.toLowerCase()
        && (s.model == null || s.model.toLowerCase() === it.model.toLowerCase()))
      const svc = matches.find((s) => s.model != null) || matches[0]   // a model-specific price wins over the brand-wide one
      if (!svc) return null
      const label = `${it.brand} ${it.model} — ${svc.title}`
      if (Number(svc.parts_price) > 0) lines.push({ itemId: it.id, kind: 'PART', description: `${label} (parts)`, qty: 1, unitPrice: Number(svc.parts_price), serviceCode: svc.id, problemCategory: issue })
      if (Number(svc.labour_price) > 0) lines.push({ itemId: it.id, kind: 'LABOUR', description: `${label} (labour)`, qty: 1, unitPrice: Number(svc.labour_price), serviceCode: svc.id, problemCategory: issue })
      daysMin = Math.max(daysMin, svc.est_days_min); daysMax = Math.max(daysMax, svc.est_days_max)
      warranty = Math.min(warranty, svc.warranty_days); pickup = pickup && svc.pickup_delivery
    }
  }
  return { lines, daysMin, daysMax, warranty: Number.isFinite(warranty) ? warranty : 0, pickup }
}

/**
 * Create a live quote from every in-range vendor's price list. Safe to re-run: existing offers are kept.
 * @returns {Promise<number>} offers created
 */
export async function generateOffers(requestId) {
  const { rows } = await query(`SELECT * FROM repair_requests WHERE id = $1`, [requestId])
  const req = rows[0]
  if (!req || req.flow !== 'MARKETPLACE' || req.status !== 'REQUESTED') return 0
  const s = await getSettings()
  if (!s.auto_quote_enabled) return 0
  const { rows: items } = await query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no', [requestId])
  const { rows: services } = await query(
    `SELECT * FROM repair_vendor_services WHERE is_active AND lower(brand) = ANY($1)`, [[...new Set(items.map((i) => i.brand.toLowerCase()))]])
  const byVendor = new Map()
  for (const sv of services) { if (!byVendor.has(sv.vendor_id)) byVendor.set(sv.vendor_id, []); byVendor.get(sv.vendor_id).push(sv) }
  if (!byVendor.size) return 0
  const shops = (await liveShops([...byVendor.keys()]))
  const shopsByVendor = new Map()
  for (const sh of shops) { if (!shopsByVendor.has(sh.vendor_id)) shopsByVendor.set(sh.vendor_id, []); shopsByVendor.get(sh.vendor_id).push(sh) }

  const candidates = []
  for (const [vendorId, svcs] of byVendor) {
    const near = nearestShop(shopsByVendor.get(vendorId) || [], req, s.search_radius_km)
    if (!near) continue
    const priced = priceRequest(items, svcs)
    if (priced) candidates.push({ vendorId, near, priced })
  }
  candidates.sort((a, b) => (a.near.distanceKm ?? 1e9) - (b.near.distanceKm ?? 1e9))
  let made = 0
  for (const c of candidates.slice(0, s.max_offers)) {
    const q = computeQuote({ lines: c.priced.lines, discountPct: 0, taxPct: Number(s.tax_pct) })
    const { rowCount } = await query(
      `INSERT INTO repair_offers (request_id, vendor_id, source, lines, subtotal, tax_pct, tax_amount, total, est_days_min, est_days_max, warranty_days, pickup_delivery, shop_visit, distance_km, valid_until)
       VALUES ($1,$2,'AUTO',$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12, NOW() + ($13 || ' days')::interval)
       ON CONFLICT (request_id, vendor_id) DO NOTHING`,
      [requestId, c.vendorId, JSON.stringify(q.lines), q.subtotal, q.taxPct, q.taxAmount, q.total, c.priced.daysMin, c.priced.daysMax, c.priced.warranty, c.priced.pickup, c.near.distanceKm, String(s.estimate_validity_days)])
    made += rowCount
  }
  if (made) await tx(async (client) => addEvent(client, requestId, 'OFFERS', `${made} nearby repair ${made === 1 ? 'shop has' : 'shops have'} quoted`, { kind: 'SYSTEM' }, { meta: { made } }))
  return made
}

// ── vendor: incoming requests and hand-written quotes ───────────────────

/** Anonymised request view for a vendor that has not been chosen. */
function vendorRequestView(r, items, offer, distanceKm) {
  const first = String(r.customer_name || 'Customer').trim().split(/\s+/)[0]
  return {
    id: r.id, code: r.code, status: r.status, createdAt: r.created_at.toISOString(), offersCloseAt: r.offers_close_at?.toISOString() ?? null,
    customer: { firstName: first, pincode: r.customer_pincode, completedRepairs: Number(r.customer_repairs ?? 0) },
    distanceKm,
    description: r.description,
    items: items.map((i) => ({
      id: i.id, category: i.category, brand: i.brand, model: i.model, imeiSerial: i.imei_serial, color: i.color, problemCategories: i.problem_categories?.length ? i.problem_categories : [i.problem_category],
      problemDescription: i.problem_description, warrantyStatus: i.warranty_status,
    })),
    offer: offer ? serializeOffer(offer) : null,
  }
}

async function vendorCanSee(vendorId, req) {
  const s = await getSettings()
  const shops = await liveShops([vendorId])
  return nearestShop(shops, req, s.search_radius_km)
}

/** Open requests near a vendor. tab: new (not quoted yet) | quoted | all (new + quoted) | rejected (this vendor passed on them). */
export async function listIncoming(actor, f = {}) {
  if (actor.kind !== 'VENDOR' || !actor.vendorId) throw new RepairError('FORBIDDEN', 'Service centre access required', 403)
  const s = await getSettings()
  const shops = await liveShops([actor.vendorId])
  const { rows: cc } = await query(
    `SELECT COUNT(*) FILTER (WHERE status = ANY($2))::int AS accepted, COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
       FROM repair_requests WHERE assigned_vendor_id = $1 AND flow = 'MARKETPLACE'`, [actor.vendorId, TABS.active])
  const done = { accepted: cc[0].accepted, completed: cc[0].completed }
  if (!shops.length) return { items: [], total: 0, counts: { new: 0, quoted: 0, rejected: 0, ...done } }
  const { rows } = await query(
    `SELECT r.* FROM repair_requests r
      WHERE r.flow = 'MARKETPLACE' AND r.status = 'REQUESTED' AND r.offers_close_at > NOW()
      ORDER BY r.created_at DESC LIMIT 300`)
  const mine = []
  for (const r of rows) { const near = nearestShop(shops, r, s.search_radius_km); if (near) mine.push({ r, near }) }
  const ids = mine.map((m) => m.r.id)
  const [{ rows: items }, { rows: offers }, { rows: declines }] = ids.length
    ? await Promise.all([
      query('SELECT * FROM repair_items WHERE request_id = ANY($1) ORDER BY request_id, line_no', [ids]),
      query(`SELECT * FROM repair_offers WHERE request_id = ANY($1) AND vendor_id = $2`, [ids, actor.vendorId]),
      query(`SELECT request_id FROM repair_request_declines WHERE request_id = ANY($1) AND vendor_id = $2`, [ids, actor.vendorId]),
    ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }]
  const offerBy = new Map(offers.map((o) => [o.request_id, o]))
  const declined = new Set(declines.map((d) => d.request_id))
  const view = ({ r, near }) => vendorRequestView(r, items.filter((i) => i.request_id === r.id), offerBy.get(r.id) || null, near.distanceKm)
  const all = mine.filter((m) => !declined.has(m.r.id)).map(view)
  const rejected = mine.filter((m) => declined.has(m.r.id)).map(view)
  const quoted = all.filter((x) => x.offer && x.offer.status !== 'WITHDRAWN')
  const fresh = all.filter((x) => !quoted.includes(x))
  const counts = { new: fresh.length, quoted: quoted.length, rejected: rejected.length, ...done }
  const list = f.tab === 'quoted' ? quoted : f.tab === 'all' ? all : f.tab === 'rejected' ? rejected : fresh
  return { items: list, total: list.length, counts }
}

export async function getIncoming(actor, id) {
  if (actor.kind !== 'VENDOR' || !actor.vendorId) throw new RepairError('FORBIDDEN', 'Service centre access required', 403)
  const { rows } = await query(`SELECT * FROM repair_requests WHERE id = $1 AND flow = 'MARKETPLACE' AND status = 'REQUESTED'`, [id])
  const req = rows[0]
  const near = req && await vendorCanSee(actor.vendorId, req)
  if (!req || !near) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  const [{ rows: items }, { rows: offers }, { rows: media }] = await Promise.all([
    query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no', [id]),
    query('SELECT * FROM repair_offers WHERE request_id = $1 AND vendor_id = $2', [id, actor.vendorId]),
    query(`SELECT id, media_type, evidence_stage FROM repair_media WHERE entity_id = $1 AND evidence_stage = 'CUSTOMER_SUBMISSION' ORDER BY created_at`, [id]),
  ])
  const { rows: hist } = await query(`SELECT COUNT(*)::int AS n FROM repair_requests WHERE user_id = $1 AND status = 'COMPLETED'`, [req.user_id])
  req.customer_repairs = hist[0].n
  const view = vendorRequestView(req, items, offers[0] || null, near.distanceKm)
  view.media = media.map((m) => ({ id: m.id, type: m.media_type }))
  return view
}

/** A vendor may open a signed link for a customer-submitted photo of a request it can quote on. */
export async function vendorCanOpenMedia(actor, requestId) {
  await getIncoming(actor, requestId)
}

function cleanOfferLines(raw, items) {
  if (!Array.isArray(raw) || !raw.length) throw new RepairError('VALIDATION', 'Add at least one price line', 422)
  if (raw.length > 60) throw new RepairError('VALIDATION', 'Too many lines in one quote', 422)
  const ids = new Set(items.map((i) => i.id))
  return raw.map((l, n) => {
    if (!LINE_KINDS.includes(l.kind)) throw new RepairError('VALIDATION', `Line ${n + 1}: choose parts, labour or other`, 422)
    const description = text(l.description, 200)
    if (description.length < 2) throw new RepairError('VALIDATION', `Line ${n + 1}: add a description`, 422)
    const qty = int(l.qty ?? 1, `Line ${n + 1} quantity`, 1, 1000, 1)
    const unitPrice = price(l.unitPrice, `Line ${n + 1}`)
    if (l.itemId != null && !ids.has(l.itemId)) throw new RepairError('VALIDATION', `Line ${n + 1}: that device is not on this request`, 422)
    if (l.problemCategory != null && !PROBLEMS.includes(l.problemCategory)) throw new RepairError('VALIDATION', `Line ${n + 1}: unknown repair type`, 422)
    return { itemId: l.itemId ?? (items.length === 1 ? items[0].id : null), kind: l.kind, description, qty, unitPrice, ...(l.problemCategory ? { problemCategory: l.problemCategory } : {}) }
  })
}

/** Send (or revise) this vendor's quote. Admin may quote for a named vendor. */
export async function placeOffer(actor, requestId, input = {}) {
  const vendorId = ownerVendor(actor, input.vendorId)
  const s = await getSettings()
  const out = await tx(async (client) => {
    const { rows } = await client.query(`SELECT * FROM repair_requests WHERE id = $1 FOR UPDATE`, [requestId])
    const req = rows[0]
    if (!req || req.flow !== 'MARKETPLACE') throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
    if (req.status !== 'REQUESTED') throw new RepairError('INVALID_STATE', 'This request is no longer taking quotes', 409)
    if (req.offers_close_at && req.offers_close_at.getTime() < Date.now()) throw new RepairError('OFFERS_CLOSED', 'Quotes for this request have closed', 409)
    const near = await vendorCanSee(vendorId, req)
    if (!near) throw new RepairError('OUT_OF_RANGE', 'This request is outside your service area', 403)
    const { rows: items } = await client.query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no', [requestId])
    const lines = cleanOfferLines(input.lines, items)
    const covered = new Set(lines.map((l) => l.itemId).filter(Boolean))
    if (items.length > 1 && items.some((i) => !covered.has(i.id))) throw new RepairError('UNPRICED_DEVICE', 'Price every device on the request', 422)
    const { rows: n } = await client.query(`SELECT COUNT(*)::int AS n FROM repair_offers WHERE request_id = $1 AND status = 'OPEN' AND vendor_id <> $2`, [requestId, vendorId])
    if (n[0].n >= s.max_offers) throw new RepairError('OFFERS_FULL', 'This request already has the maximum number of quotes', 409)
    const q = computeQuote({ lines, discountPct: 0, taxPct: Number(s.tax_pct) })
    const daysMin = int(input.estDaysMin, 'Minimum days', 0, 60, 1)
    const daysMax = int(input.estDaysMax, 'Maximum days', 0, 60, Math.max(daysMin, 2))
    if (daysMax < daysMin) throw new RepairError('VALIDATION', 'Maximum days cannot be below minimum days', 422)
    const mrp = input.mrpTotal != null && input.mrpTotal !== '' ? price(input.mrpTotal, 'Original price') : null
    if (mrp != null && mrp < q.total) throw new RepairError('VALIDATION', 'Original price cannot be below the quote', 422)
    const { rows: o } = await client.query(
      `INSERT INTO repair_offers (request_id, vendor_id, source, status, lines, subtotal, tax_pct, tax_amount, total, mrp_total, est_days_min, est_days_max, warranty_days,
              pickup_delivery, shop_visit, distance_km, note, valid_until, created_by)
       VALUES ($1,$2,'MANUAL','OPEN',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW() + ($16 || ' days')::interval, $17)
       ON CONFLICT (request_id, vendor_id) DO UPDATE SET source = 'MANUAL', status = 'OPEN', lines = EXCLUDED.lines, subtotal = EXCLUDED.subtotal, tax_pct = EXCLUDED.tax_pct,
         tax_amount = EXCLUDED.tax_amount, total = EXCLUDED.total, mrp_total = EXCLUDED.mrp_total, est_days_min = EXCLUDED.est_days_min, est_days_max = EXCLUDED.est_days_max,
         warranty_days = EXCLUDED.warranty_days, pickup_delivery = EXCLUDED.pickup_delivery, shop_visit = EXCLUDED.shop_visit, distance_km = EXCLUDED.distance_km,
         note = EXCLUDED.note, valid_until = EXCLUDED.valid_until, created_by = EXCLUDED.created_by, updated_at = NOW()
       RETURNING *`,
      [requestId, vendorId, JSON.stringify(q.lines), q.subtotal, q.taxPct, q.taxAmount, q.total, mrp, daysMin, daysMax,
        int(input.warrantyDays, 'Warranty days', 0, 730, s.default_warranty_days), input.pickupDelivery !== false, input.shopVisit !== false,
        near.distanceKm, text(input.note, 500) || null, String(s.estimate_validity_days), actor.userId])
    await client.query('DELETE FROM repair_request_declines WHERE request_id = $1 AND vendor_id = $2', [requestId, vendorId])
    await addEvent(client, requestId, 'OFFERS', `A repair shop sent a quote — ₹${q.total}`, actor, { meta: { vendorId, total: q.total } })
    return o[0]
  })
  return serializeOffer(out)
}

export async function withdrawOffer(actor, requestId, vendorIdIn) {
  const vendorId = ownerVendor(actor, vendorIdIn)
  const { rows } = await query(
    `UPDATE repair_offers SET status = 'WITHDRAWN', updated_at = NOW() WHERE request_id = $1 AND vendor_id = $2 AND status = 'OPEN' RETURNING *`, [requestId, vendorId])
  if (!rows[0]) throw new RepairError('NOT_FOUND', 'No open quote to withdraw', 404)
  return serializeOffer(rows[0])
}

// ── customer: compare offers ────────────────────────────────────────────

function serializeOffer(o, extra = {}) {
  return {
    id: o.id, requestId: o.request_id, vendorId: o.vendor_id, source: o.source, live: o.source === 'AUTO', status: o.status,
    lines: o.lines, subtotal: num(o.subtotal), taxPct: num(o.tax_pct), taxAmount: num(o.tax_amount), total: num(o.total), mrpTotal: num(o.mrp_total),
    estDaysMin: o.est_days_min, estDaysMax: o.est_days_max, warrantyDays: o.warranty_days, pickupDelivery: o.pickup_delivery, shopVisit: o.shop_visit,
    distanceKm: num(o.distance_km), note: o.note, validUntil: o.valid_until.toISOString(), expired: o.valid_until.getTime() < Date.now(), createdAt: o.created_at.toISOString(),
    ...extra,
  }
}

/** Offers for a request, with each vendor's rating. Customers see only live offers; staff see everything. */
export async function listOffers(actor, requestId, { sort = 'best' } = {}) {
  if (!SORTS.includes(sort)) throw new RepairError('VALIDATION', 'Unknown sort order', 422)
  const detail = await getManage(actor, requestId)
  const staff = actor.kind !== 'CUSTOMER'
  const { rows } = await query(
    `SELECT o.*, v.name AS vendor_name, v.phone AS vendor_phone,
            sh.name AS shop_name, concat_ws(', ', sh.address_line1, sh.address_line2, sh.city, sh.state, sh.pincode) AS shop_address,
            (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM repair_requests r WHERE r.assigned_vendor_id = o.vendor_id AND r.rating IS NOT NULL) AS rating,
            (SELECT COUNT(*)::int FROM repair_requests r WHERE r.assigned_vendor_id = o.vendor_id AND r.rating IS NOT NULL) AS rating_count,
            (SELECT COUNT(*)::int FROM repair_requests r WHERE r.assigned_vendor_id = o.vendor_id AND r.status = 'COMPLETED') AS completed_repairs
       FROM repair_offers o
       JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN LATERAL (SELECT * FROM shops s WHERE s.vendor_id = o.vendor_id AND s.deleted_at IS NULL AND s.is_active
                           ORDER BY (s.lat - COALESCE($2::numeric, s.lat))^2 + (s.lng - COALESCE($3::numeric, s.lng))^2 LIMIT 1) sh ON TRUE
      WHERE o.request_id = $1 ${staff ? '' : `AND o.status IN ('OPEN','SELECTED') AND (o.valid_until > NOW() OR o.status = 'SELECTED')`}`,
    [requestId, detail.location?.lat ?? null, detail.location?.lng ?? null])
  let list = rows.map((o) => serializeOffer(o, {
    vendor: {
      id: o.vendor_id, name: o.vendor_name, shopName: o.shop_name || o.vendor_name, address: o.shop_address || null,
      rating: o.rating != null ? Number(o.rating) : null, ratingCount: o.rating_count, completedRepairs: o.completed_repairs,
      ...(staff ? { phone: o.vendor_phone } : {}),
    },
  }))
  const open = list.filter((o) => o.status === 'OPEN' && !o.expired)
  const lowest = open.length ? Math.min(...open.map((o) => o.total)) : null
  const score = (o) => {   // lower is better: price dominates, then distance, then rating
    const rating = o.vendor.rating ?? 3
    return o.total + (o.distanceKm ?? 10) * 8 - rating * 40
  }
  const cmp = {
    best: (a, b) => score(a) - score(b),
    nearest: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.total - b.total,
    lowest_price: (a, b) => a.total - b.total || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
    highest_rating: (a, b) => (b.vendor.rating ?? 0) - (a.vendor.rating ?? 0) || a.total - b.total,
  }[sort]
  list.sort((a, b) => (a.status === 'SELECTED' ? -1 : b.status === 'SELECTED' ? 1 : cmp(a, b)))
  const bestId = open.length ? [...open].sort(cmp.best)[0].id : null
  list = list.map((o) => ({ ...o, badges: [...(o.id === bestId && open.length > 1 ? ['BEST_DEAL'] : []), ...(o.total === lowest && open.length > 1 ? ['LOWEST_PRICE'] : []), ...(o.live ? ['LIVE_QUOTE'] : [])] }))
  return { requestId, status: detail.status, count: open.length, lowestTotal: lowest, offersCloseAt: detail.offersCloseAt, offers: list }
}

// ── customer: select an offer ───────────────────────────────────────────

/**
 * Pick one offer and say how the device travels: pickup & delivery from an address, or a shop appointment.
 * The vendor becomes the service centre for the request and the lifecycle moves to ACCEPTED.
 */
export async function selectOffer(actor, requestId, offerId, input = {}) {
  if (actor.kind !== 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only the customer can choose an offer', 403)
  const fulfilment = input.fulfilment
  if (!FULFILMENT.includes(fulfilment)) throw new RepairError('VALIDATION', 'Choose pickup & delivery or a shop appointment', 422)
  const when = (v, label, required) => {
    if (v == null || v === '') { if (required) throw new RepairError('VALIDATION', `${label} is required`, 422); return null }
    const d = new Date(v)
    if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - 300_000) throw new RepairError('VALIDATION', `${label} must be in the future`, 422)
    return d
  }
  const slot = fulfilment === 'PICKUP_DELIVERY' ? when(input.pickupSlot, 'Pickup time', false) : null
  const appointment = fulfilment === 'SHOP_VISIT' ? when(input.appointmentAt, 'Appointment time', true) : null
  let address = text(input.pickupAddress, 500)
  if (fulfilment === 'PICKUP_DELIVERY' && input.addressId) {
    const { rows } = await query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [input.addressId, actor.userId])
    if (!rows[0]) throw new RepairError('VALIDATION', 'Choose one of your saved addresses', 422)
    const a = rows[0]
    address = [a.address_line1, a.address_line2, a.landmark, a.city, a.state, a.pincode].filter(Boolean).join(', ')
  }

  const vendorName = await tx(async (client) => {
    const r = await lock(client, requestId, actor)
    if (r.flow !== 'MARKETPLACE') throw new RepairError('INVALID_STATE', 'This request does not use quotes', 409)
    if (r.status !== 'REQUESTED') throw new RepairError('INVALID_STATE', 'An offer has already been chosen or the request is closed', 409)
    const { rows } = await client.query(
      `SELECT o.*, v.name AS vendor_name, (v.deleted_at IS NULL AND v.is_active AND v.status IN ('VERIFIED','ACTIVE')) AS vendor_live
         FROM repair_offers o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = $1 AND o.request_id = $2 FOR UPDATE OF o`, [offerId, requestId])
    const o = rows[0]
    if (!o) throw new RepairError('NOT_FOUND', 'Offer not found', 404)
    if (o.status !== 'OPEN') throw new RepairError('OFFER_UNAVAILABLE', 'That offer is no longer available', 409)
    if (o.valid_until.getTime() < Date.now()) throw new RepairError('OFFER_EXPIRED', 'That offer has expired — pick another or ask the shop to requote', 409)
    if (!o.vendor_live) throw new RepairError('OFFER_UNAVAILABLE', 'That repair shop is not available right now', 409)
    if (fulfilment === 'PICKUP_DELIVERY') {
      if (!o.pickup_delivery) throw new RepairError('FULFILMENT_UNAVAILABLE', 'This shop does not offer pickup & delivery', 409)
      if (!address) address = r.pickup_address || ''
      if (address.length < 10) throw new RepairError('VALIDATION', 'Enter the full pickup address', 422)
    } else if (!o.shop_visit) throw new RepairError('FULFILMENT_UNAVAILABLE', 'This shop does not take shop appointments', 409)

    await client.query(`UPDATE repair_offers SET status = 'SELECTED', updated_at = NOW() WHERE id = $1`, [offerId])
    await client.query(`UPDATE repair_offers SET status = 'NOT_SELECTED', updated_at = NOW() WHERE request_id = $1 AND id <> $2 AND status = 'OPEN'`, [requestId, offerId])
    await moveTo(client, r, 'ACCEPTED', actor, `Offer accepted — ${o.vendor_name} · ₹${o.total}`, {
      assigned_vendor_id: o.vendor_id, selected_offer_id: offerId, fulfilment,
      service_mode: fulfilment === 'PICKUP_DELIVERY' ? 'PICKUP' : 'DROP_OFF',
      pickup_address: fulfilment === 'PICKUP_DELIVERY' ? address : r.pickup_address,
      pickup_slot: slot, appointment_at: appointment,
    }, { offerId, vendorId: o.vendor_id, total: Number(o.total), fulfilment })
    if (slot) await addEvent(client, requestId, 'PICKUP_SCHEDULED', 'Pickup scheduled', actor, { meta: { slot: slot.toISOString() } })
    if (appointment) await addEvent(client, requestId, 'APPOINTMENT_BOOKED', 'Shop appointment booked', actor, { meta: { at: appointment.toISOString() } })
    return o.vendor_name
  })
  logger.info({ requestId, offerId, vendorName }, 'repair offer selected')
  notifyRepair('ACCEPTED', requestId, { skipCustomer: true })
  return getManage(actor, requestId)
}

// ── vendor: logistics steps (status only — no live location) ────────────

async function stepGuard(client, actor, id) {
  if (actor.kind === 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only repair staff can do this', 403)
  return lock(client, id, actor)
}

/** Set or change the pickup time (ACCEPTED, pickup & delivery only). */
export const schedulePickup = (actor, id, { slot, note } = {}) => tx(async (client) => {
  const r = await stepGuard(client, actor, id)
  if (r.fulfilment !== 'PICKUP_DELIVERY' || r.status !== 'ACCEPTED') throw new RepairError('INVALID_STATE', 'Pickup can only be scheduled for an accepted pickup & delivery repair', 409)
  const d = new Date(slot)
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - 300_000) throw new RepairError('VALIDATION', 'Pickup time must be in the future', 422)
  await patch(client, id, { pickup_slot: d })
  await addEvent(client, id, 'PICKUP_SCHEDULED', 'Pickup scheduled', actor, { meta: { slot: d.toISOString(), note: text(note, 200) || undefined } })
}).then(() => getManage(actor, id))

/** The device has been collected from the customer. */
export const markPickedUp = (actor, id, { note } = {}) => tx(async (client) => {
  const r = await stepGuard(client, actor, id)
  if (r.fulfilment !== 'PICKUP_DELIVERY' || r.status !== 'ACCEPTED') throw new RepairError('INVALID_STATE', 'Only an accepted pickup & delivery repair can be marked picked up', 409)
  const { rows } = await client.query(`SELECT 1 FROM repair_events WHERE request_id = $1 AND kind = 'PICKED_UP'`, [id])
  if (rows[0]) throw new RepairError('INVALID_STATE', 'Already marked as picked up', 409)
  await addEvent(client, id, 'PICKED_UP', 'Device picked up from the customer', actor, { meta: { note: text(note, 200) || undefined } })
  await patch(client, id, {})
}).then(() => getManage(actor, id))

/** The repaired device is on its way back. Optional courier name and tracking link — never a live position. */
export const markOutForDelivery = (actor, id, { courier, trackingUrl, note } = {}) => tx(async (client) => {
  const r = await stepGuard(client, actor, id)
  if (r.fulfilment !== 'PICKUP_DELIVERY' || r.status !== 'READY_FOR_DELIVERY') throw new RepairError('INVALID_STATE', 'Mark the repair ready for delivery first', 409)
  let url = null
  if (trackingUrl) {
    try { const u = new URL(trackingUrl); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme'); url = u.toString() } catch { throw new RepairError('VALIDATION', 'Tracking link must be a web address', 422) }
  }
  const { rows } = await client.query(`SELECT 1 FROM repair_events WHERE request_id = $1 AND kind = 'OUT_FOR_DELIVERY'`, [id])
  if (rows[0]) throw new RepairError('INVALID_STATE', 'Already marked out for delivery', 409)
  await addEvent(client, id, 'OUT_FOR_DELIVERY', 'Out for delivery', actor, { meta: { courier: text(courier, 80) || undefined, trackingUrl: url || undefined, note: text(note, 200) || undefined } })
  await patch(client, id, {})
}).then(() => getManage(actor, id))

/**
 * The customer's price was agreed when they chose the offer, so after inspection the shop either confirms it
 * (this) or sends a revised estimate through the normal estimate flow.
 */
export const confirmPrice = (actor, id) => tx(async (client) => {
  if (actor.kind === 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only repair staff can do this', 403)
  const r = await lock(client, id, actor)
  if (r.status !== 'INSPECTION' || !r.selected_offer_id) throw new RepairError('INVALID_STATE', 'There is no agreed offer price to confirm at this stage', 409)
  const { rows: o } = await client.query('SELECT * FROM repair_offers WHERE id = $1', [r.selected_offer_id])
  const offer = o[0]
  if (!offer) throw new RepairError('NOT_FOUND', 'Offer not found', 404)
  const s = await getSettings(client)
  const total = Number(offer.total)
  const advance = !s.require_advance ? 0 : advanceFor(total, Number(s.advance_pct))
  const { rows: v } = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM repair_quotes WHERE request_id = $1', [id])
  const { rows: q } = await client.query(
    `INSERT INTO repair_quotes (request_id, version, status, lines, subtotal, discount_pct, discount_amount, taxable, tax_pct, tax_amount, total, note, valid_until, created_by, decided_by, decided_at, decision_note)
     VALUES ($1,$2,'APPROVED',$3,$4,0,0,$4,$5,$6,$7,$8, NOW() + INTERVAL '1 day', $9, $10, NOW(), 'Price agreed when the customer chose this offer') RETURNING id`,
    [id, v[0].v, JSON.stringify(offer.lines), offer.subtotal, offer.tax_pct, offer.tax_amount, offer.total, offer.note, actor.userId, r.user_id])
  await moveTo(client, r, 'ESTIMATE_APPROVED', actor, `Agreed price confirmed — ₹${total}`, { approved_quote_id: q[0].id, approved_total: total, advance_required: advance }, { total, advance })
}).then(() => getManage(actor, id))

// ── customer: rate a finished repair ────────────────────────────────────

export const rate = (actor, id, { stars, review } = {}) => tx(async (client) => {
  if (actor.kind !== 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only the customer can rate a repair', 403)
  const r = await lock(client, id, actor)
  if (r.status !== 'COMPLETED' || !r.assigned_vendor_id) throw new RepairError('INVALID_STATE', 'You can rate a repair once it is completed', 409)
  if (r.rating != null) throw new RepairError('ALREADY_RATED', 'You have already rated this repair', 409)
  const n = Number(stars)
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new RepairError('VALIDATION', 'Choose 1 to 5 stars', 422)
  await patch(client, id, { rating: n, review: text(review, 1000) || null, rated_at: new Date() })
  await addEvent(client, id, 'RATED', `Rated ${n} star${n === 1 ? '' : 's'}`, actor, { meta: { stars: n } })
}).then(() => getManage(actor, id))

// ── tracking ────────────────────────────────────────────────────────────

const FLOWS = {
  PICKUP_DELIVERY: [
    ['Request Accepted', 'ACCEPTED'], ['Pickup Scheduled', 'PICKUP_SCHEDULED'], ['Device Picked Up', 'PICKED_UP'], ['At Repair Shop', 'INSPECTION'],
    ['Repair in Progress', 'IN_REPAIR'], ['Quality Check', 'QC_PENDING'], ['Out for Delivery', 'OUT_FOR_DELIVERY'], ['Delivered', 'COMPLETED'],
  ],
  SHOP_VISIT: [
    ['Request Accepted', 'ACCEPTED'], ['Appointment Booked', 'APPOINTMENT_BOOKED'], ['Device Received at Shop', 'INSPECTION'],
    ['Repair in Progress', 'IN_REPAIR'], ['Quality Check', 'QC_PENDING'], ['Ready for Pickup', 'READY_FOR_DELIVERY'], ['Collected', 'COMPLETED'],
  ],
}
const PRE_SELECTION = [['Request Submitted', 'REQUESTED'], ['Offers Received', 'OFFERS'], ['Choose an Offer', 'ACCEPTED']]

/** Step-by-step progress for the customer's tracking screen. Status only — there is no live map. */
export async function tracking(actor, requestId) {
  const r = await getManage(actor, requestId)
  const { rows: ev } = await query('SELECT kind, created_at, meta FROM repair_events WHERE request_id = $1 ORDER BY id', [requestId])
  const first = new Map()
  for (const e of ev) if (!first.has(e.kind)) first.set(e.kind, e)
  const defs = r.fulfilment ? FLOWS[r.fulfilment] : PRE_SELECTION
  const rework = r.status === 'IN_REPAIR' && r.reworkCount > 0
  const steps = defs.map(([label, kind]) => {
    const e = first.get(kind)
    const done = !!e && !(rework && kind === 'QC_PENDING')
    return { key: kind, label, done, at: done ? e.created_at.toISOString() : null, meta: done && kind === 'OUT_FOR_DELIVERY' ? e.meta : undefined }
  })
  const current = steps.findIndex((s) => !s.done)
  steps.forEach((s, i) => { s.current = i === current })
  const closed = ['REJECTED', 'CANCELLED', 'ESTIMATE_REJECTED', 'FAILED'].includes(r.status)
  const { rows: v } = r.serviceCenterId ? await query('SELECT name, phone FROM vendors WHERE id = $1', [r.serviceCenterId]) : { rows: [] }
  return {
    requestId: r.id, code: r.code, status: r.status, fulfilment: r.fulfilment, closed,
    note: r.note ?? null,
    pickupSlot: r.pickupSlot, appointmentAt: r.appointmentAt,
    serviceCenter: v[0] ? { id: r.serviceCenterId, name: v[0].name, phone: v[0].phone, technician: r.technician } : null,
    steps,
    amount: { approvedTotal: r.money.approvedTotal, amountPaid: r.money.amountPaid, amountDue: r.money.amountDue },
    warrantyUntil: r.warrantyUntil, rating: r.rating,
  }
}

// ── booking-form helpers ────────────────────────────────────────────────

/** Brand tiles: brands from the device catalogue plus any brand a repair shop has priced. */
export async function catalogueBrands({ category } = {}) {
  const cat = CATEGORIES.includes(category) ? category : null
  const { rows } = await query(
    `SELECT brand AS name, MAX(brand_logo_url) AS logo_url, COUNT(*)::int AS models FROM sell_device_models
      WHERE is_active AND brand IS NOT NULL AND ($1::text IS NULL OR category = $1) GROUP BY brand
     UNION ALL
     SELECT s.brand, NULL, 0 FROM repair_vendor_services s WHERE s.is_active AND ($1::text IS NULL OR s.device_category = $1)
        AND NOT EXISTS (SELECT 1 FROM sell_device_models m WHERE m.is_active AND lower(m.brand) = lower(s.brand))
      GROUP BY s.brand
     ORDER BY 3 DESC, 1`, [cat])
  return rows.map((r) => ({ name: r.name, logoUrl: r.logo_url, models: r.models }))
}

export async function catalogueModels({ brand, q, category } = {}) {
  const b = text(brand, 60)
  if (!b) throw new RepairError('VALIDATION', 'Choose a brand', 422)
  const cat = CATEGORIES.includes(category) ? category : null
  const { rows } = await query(
    `SELECT name, category, image_url FROM sell_device_models
      WHERE is_active AND lower(brand) = lower($1) AND ($2::text IS NULL OR category = $2) AND ($3::text IS NULL OR name ILIKE $3)
      ORDER BY name LIMIT 200`, [b, cat, q ? `%${text(q, 60)}%` : null])
  return rows.map((r) => ({ name: r.name, category: r.category, imageUrl: r.image_url }))
}

/** "My recent devices": distinct devices the customer has already repaired or requested. */
export async function recentDevices(userId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(i.brand), lower(i.model)) i.brand, i.model, i.category, r.created_at
       FROM repair_items i JOIN repair_requests r ON r.id = i.request_id WHERE r.user_id = $1
      ORDER BY lower(i.brand), lower(i.model), r.created_at DESC`, [userId])
  return rows.sort((a, b) => b.created_at - a.created_at).slice(0, 5).map((r) => ({ brand: r.brand, model: r.model, category: r.category }))
}

// ── vendor app: on/off switch, pre-filled quote, repair updates ─────────

export async function getProfile(actor, vendorIdIn) {
  const vendorId = ownerVendor(actor, vendorIdIn)
  const { rows } = await query('SELECT accepting_requests FROM repair_vendor_profiles WHERE vendor_id = $1', [vendorId])
  const { rows: n } = await query('SELECT COUNT(*)::int AS n FROM repair_vendor_services WHERE vendor_id = $1 AND is_active', [vendorId])
  return { vendorId, acceptingRequests: rows[0]?.accepting_requests ?? true, activeServices: n[0].n }
}

/** "Service available in nearby areas": switch quoting on or off without touching the price list. */
export async function setProfile(actor, input = {}) {
  const vendorId = ownerVendor(actor, input.vendorId)
  if (typeof input.acceptingRequests !== 'boolean') throw new RepairError('VALIDATION', 'acceptingRequests must be true or false', 422)
  await assertVendor(vendorId)
  await query(
    `INSERT INTO repair_vendor_profiles (vendor_id, accepting_requests) VALUES ($1,$2)
     ON CONFLICT (vendor_id) DO UPDATE SET accepting_requests = EXCLUDED.accepting_requests, updated_at = NOW()`, [vendorId, input.acceptingRequests])
  return getProfile(actor, vendorId)
}

/** Quote lines the vendor's own price list gives for this request; issues it has no price for come back in `missing`. */
export async function suggestedQuote(actor, requestId, vendorIdIn) {
  const vendorId = ownerVendor(actor, vendorIdIn)
  const { rows } = await query(`SELECT * FROM repair_requests WHERE id = $1 AND flow = 'MARKETPLACE' AND status = 'REQUESTED'`, [requestId])
  if (!rows[0] || !(await vendorCanSee(vendorId, rows[0]))) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  const [{ rows: items }, { rows: services }] = await Promise.all([
    query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no', [requestId]),
    query('SELECT * FROM repair_vendor_services WHERE vendor_id = $1 AND is_active', [vendorId]),
  ])
  const lines = [], missing = []
  let daysMin = 0, daysMax = 0, warranty = Infinity
  for (const it of items) {
    for (const issue of it.problem_categories?.length ? it.problem_categories : [it.problem_category]) {
      const m = services.filter((s) => s.device_category === it.category && s.problem_category === issue && s.brand.toLowerCase() === it.brand.toLowerCase() && (s.model == null || s.model.toLowerCase() === it.model.toLowerCase()))
      const sv = m.find((x) => x.model != null) || m[0]
      if (!sv) { missing.push({ itemId: it.id, problemCategory: issue, label: TITLES[issue] }); continue }
      const label = `${it.brand} ${it.model} — ${sv.title}`
      if (Number(sv.parts_price) > 0) lines.push({ itemId: it.id, kind: 'PART', description: `${label} (parts)`, qty: 1, unitPrice: Number(sv.parts_price), problemCategory: issue })
      if (Number(sv.labour_price) > 0) lines.push({ itemId: it.id, kind: 'LABOUR', description: `${label} (labour)`, qty: 1, unitPrice: Number(sv.labour_price), problemCategory: issue })
      daysMin = Math.max(daysMin, sv.est_days_min); daysMax = Math.max(daysMax, sv.est_days_max); warranty = Math.min(warranty, sv.warranty_days)
    }
  }
  const s = await getSettings()
  const q = lines.length ? computeQuote({ lines, discountPct: 0, taxPct: Number(s.tax_pct) }) : null
  return { lines, missing, estDaysMin: daysMin, estDaysMax: daysMax, warrantyDays: Number.isFinite(warranty) ? warranty : null, totals: q && { subtotal: q.subtotal, taxPct: q.taxPct, taxAmount: q.taxAmount, total: q.total } }
}

const UPDATE_STAGES = ['RECEIVED', 'DIAGNOSING', 'WAITING_FOR_PARTS', 'REPAIR_IN_PROGRESS', 'TESTING', 'OTHER']
const ISSUE_STATUSES = ['STARTED', 'DONE', 'NOT_NEEDED']
const CHECK_RESULTS = ['PASS', 'LOW', 'ISSUE']

/** Device-check rows ("Screen — pass", "Battery — low"): at most 20, plain keys, one of three results. */
function cleanChecks(raw) {
  if (raw == null) return null
  if (!Array.isArray(raw) || raw.length > 20) throw new RepairError('VALIDATION', 'Device check has too many rows', 422)
  return raw.map((c, n) => {
    const key = text(c?.key, 40).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    if (!key) throw new RepairError('VALIDATION', `Check ${n + 1}: name is missing`, 422)
    if (!CHECK_RESULTS.includes(c.result)) throw new RepairError('VALIDATION', `Check ${n + 1}: choose pass, low or issue`, 422)
    return { key, label: text(c.label, 60) || key, result: c.result }
  })
}

/** The part used for one repair (name, price, warranty) — shown to the customer with the progress update. */
function cleanPart(raw) {
  if (raw == null) return null
  const name = text(raw.name, 120)
  if (!name) throw new RepairError('VALIDATION', 'Part name is required', 422)
  return {
    name,
    price: raw.price != null && raw.price !== '' ? price(raw.price, 'Part price') : null,
    warrantyDays: int(raw.warrantyDays, 'Part warranty days', 0, 730, 0),
  }
}

/**
 * Technician progress note with optional photos; the customer sees it in their timeline when `notify` is set.
 * Per-issue progress ("Battery replacement — done") rides on the same event: `issue` (one of the request's issues),
 * `issueStatus`, optional `part` and `itemId`; the diagnosis screen sends `checks`.
 */
export const addRepairUpdate = (actor, id, { stage, note, notify, mediaIds, issue, issueStatus, itemId, part, checks } = {}) => tx(async (client) => {
  if (actor.kind === 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only repair staff can do this', 403)
  const r = await lock(client, id, actor)
  if (!['ACCEPTED', 'INSPECTION', 'ESTIMATE_APPROVED', 'IN_REPAIR', 'QC_PENDING'].includes(r.status)) throw new RepairError('INVALID_STATE', 'Updates can be added while the repair is under way', 409)
  if (!UPDATE_STAGES.includes(stage)) throw new RepairError('VALIDATION', 'Choose an update type', 422)
  if (issue != null && !PROBLEMS.includes(issue)) throw new RepairError('VALIDATION', 'Unknown repair type', 422)
  if (issueStatus != null && !ISSUE_STATUSES.includes(issueStatus)) throw new RepairError('VALIDATION', 'Choose started, done or not needed', 422)
  if (issueStatus != null && issue == null) throw new RepairError('VALIDATION', 'Say which repair this status is for', 422)
  if (itemId != null) {
    const { rows } = await client.query('SELECT 1 FROM repair_items WHERE id = $1 AND request_id = $2', [itemId, id])
    if (!rows[0]) throw new RepairError('VALIDATION', 'That device is not on this request', 422)
  }
  const cleanedChecks = cleanChecks(checks)
  const cleanedPart = cleanPart(part)
  const n = text(note, 1000)
  if (!n && !(Array.isArray(mediaIds) && mediaIds.length) && !issueStatus && !cleanedChecks) throw new RepairError('VALIDATION', 'Add a note or photos', 422)
  if (Array.isArray(mediaIds) && mediaIds.length) {
    const { claimRepairMedia } = await import('./repairs.media.js')
    await claimRepairMedia(client, r, actor, mediaIds, 'REPAIR_PROGRESS')
  }
  const visible = notify !== false
  const head = issue && issueStatus
    ? `${TITLES[issue]} ${{ STARTED: 'started', DONE: 'completed', NOT_NEEDED: 'not needed' }[issueStatus]}`
    : stage.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
  await addEvent(client, id, 'TECH_UPDATE', `${head}${n ? ` — ${n}` : ''}`, actor, {
    meta: { stage, customerVisible: visible, issue: issue ?? undefined, issueStatus: issueStatus ?? undefined, itemId: itemId ?? undefined, part: cleanedPart ?? undefined, checks: cleanedChecks ?? undefined },
  })
  await patch(client, id, {})
  return visible
}).then((visible) => { if (visible) notifyRepair('UPDATE', id); return getManage(actor, id) })

// ── vendor "Reject" on an incoming request ──────────────────────────────

/** The vendor passes on a request: it leaves New/Pending (and any open quote is withdrawn) and shows under Rejected. */
export async function declineRequest(actor, requestId, { reason } = {}) {
  if (actor.kind !== 'VENDOR' || !actor.vendorId) throw new RepairError('FORBIDDEN', 'Service centre access required', 403)
  const { rows } = await query(`SELECT * FROM repair_requests WHERE id = $1 AND flow = 'MARKETPLACE' AND status = 'REQUESTED'`, [requestId])
  if (!rows[0] || !(await vendorCanSee(actor.vendorId, rows[0]))) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  const why = text(reason, 200) || null
  await tx(async (client) => {
    await client.query(
      `INSERT INTO repair_request_declines (request_id, vendor_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (request_id, vendor_id) DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()`, [requestId, actor.vendorId, why])
    await client.query(`UPDATE repair_offers SET status = 'WITHDRAWN', updated_at = NOW() WHERE request_id = $1 AND vendor_id = $2 AND status = 'OPEN'`, [requestId, actor.vendorId])
  })
  return { declined: true }
}

/** Put a rejected request back into Pending (while quotes are still open). */
export async function undeclineRequest(actor, requestId) {
  if (actor.kind !== 'VENDOR' || !actor.vendorId) throw new RepairError('FORBIDDEN', 'Service centre access required', 403)
  await query('DELETE FROM repair_request_declines WHERE request_id = $1 AND vendor_id = $2', [requestId, actor.vendorId])
  return { declined: false }
}
