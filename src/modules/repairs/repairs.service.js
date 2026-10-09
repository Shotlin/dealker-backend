/**
 * Repairs — requests, lifecycle, quotes and payments for B2C (single device) and B2B (bulk) repairs.
 *
 * Invariants
 *  - Every status change takes `SELECT … FOR UPDATE` on the request and is checked against the engine's
 *    transition table; there is no way to skip a step through the API.
 *  - Quotes and totals are computed here from line items; the client never supplies a total.
 *  - Payments are append-only and idempotent (request, idempotency key); nobody can pay more than is due
 *    or refund more than was overpaid.
 *  - Customers only see their own requests; a service centre (vendor) only sees requests assigned to it.
 *
 * @module modules/repairs/repairs.service
 */
import { getClient, query } from '../../config/database.js'
import { advanceFor, canMove, computeQuote, GSTIN_RE, LINE_KINDS, money, settle, TABS, warrantyUntil } from './repairs.engine.js'
import { claimRepairMedia, listRepairMedia } from './repairs.media.js'
import { notifyRepair } from './repairs.notify.js'

export class RepairError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message)
    this.name = 'RepairError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

const PROBLEMS = ['SCREEN', 'BATTERY', 'CHARGING', 'WATER_DAMAGE', 'SOFTWARE', 'CAMERA', 'AUDIO', 'BODY', 'BOARD', 'BIOMETRIC', 'DATA', 'OTHER']
const CATEGORIES = ['Smartphone', 'Tablet', 'Laptop', 'Other']
const WARRANTY = ['IN_WARRANTY', 'OUT_OF_WARRANTY', 'UNKNOWN']
const METHODS = ['CASH', 'UPI', 'CARD', 'BANK', 'COD', 'WALLET']
const PAY_KINDS = ['ADVANCE', 'BALANCE', 'DIAGNOSTIC', 'REFUND']
const PHONE_RE = /^\+?\d[\d ]{9,13}$/
const ACTIVE_NOT = ['COMPLETED', 'REJECTED', 'CANCELLED']
const num = (v) => (v == null ? null : Number(v))
/** node-pg returns DATE columns as local-midnight Date objects; format them back as YYYY-MM-DD. */
export const ymd = (d) => {
  if (d == null) return null
  if (typeof d === 'string') return d.slice(0, 10)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const text = (v, max) => String(v ?? '').trim().slice(0, max)

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

export async function addEvent(client, requestId, kind, label, actor, { from = null, to = null, meta = {} } = {}) {
  await client.query(
    `INSERT INTO repair_events (request_id, kind, label, from_status, to_status, actor_id, actor_role, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [requestId, kind, label, from, to, actor?.userId || null, actor?.kind || null, meta]
  )
}

export async function getSettings(client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run('SELECT * FROM repair_settings WHERE id = TRUE')
  if (!rows[0]) throw new RepairError('SETTINGS_MISSING', 'Repair settings are not initialised', 500)
  return rows[0]
}

// ── visibility ──────────────────────────────────────────────────────────

const sees = (actor, r) =>
  actor.kind === 'ADMIN' ||
  (actor.kind === 'CUSTOMER' && r.user_id === actor.userId) ||
  (actor.kind === 'VENDOR' && !!actor.vendorId && r.assigned_vendor_id === actor.vendorId)

/** Lock a request for a state change. Anything the actor cannot see is a plain 404. */
export async function lock(client, id, actor) {
  const { rows } = await client.query('SELECT * FROM repair_requests WHERE id = $1 FOR UPDATE', [id])
  if (!rows[0] || !sees(actor, rows[0])) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  return rows[0]
}

const platformOnly = (actor) => {
  if (actor.kind !== 'ADMIN') throw new RepairError('FORBIDDEN', 'Only platform staff can do this', 403)
}
const staffOnly = (actor) => {
  if (actor.kind === 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only repair staff can do this', 403)
}

async function patch(client, id, cols) {
  const keys = Object.keys(cols)
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
  await client.query(`UPDATE repair_requests SET ${sets}${sets ? ',' : ''} updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => cols[k])])
}

/** Move to a new status (transition-checked) and record it. */
async function moveTo(client, r, to, actor, label, cols = {}, meta = {}) {
  if (!canMove(r.status, to)) {
    throw new RepairError('INVALID_STATE', `A repair that is ${r.status.toLowerCase().replace(/_/g, ' ')} cannot move to ${to.toLowerCase().replace(/_/g, ' ')}`, 409, { from: r.status, to })
  }
  await patch(client, r.id, { status: to, ...cols })
  await addEvent(client, r.id, to, label, actor, { from: r.status, to, meta })
}

const amountDue = (r) => Math.max(0, money.rupees(money.paise(r.approved_total) - money.paise(r.amount_paid)))
const refundable = (r) => Math.max(0, money.rupees(money.paise(r.amount_paid) - money.paise(r.approved_total)))

// ── create ──────────────────────────────────────────────────────────────

function cleanItems(raw, max) {
  if (!Array.isArray(raw) || raw.length < 1) throw new RepairError('VALIDATION', 'Add at least one device', 422)
  if (raw.length > max) throw new RepairError('VALIDATION', `At most ${max} devices per request`, 422)
  const seen = new Set()
  return raw.map((i, idx) => {
    const brand = text(i.brand, 60), model = text(i.model, 120)
    if (!brand || !model) throw new RepairError('VALIDATION', `Device ${idx + 1}: brand and model are required`, 422)
    const problemCategory = i.problemCategory
    if (!PROBLEMS.includes(problemCategory)) throw new RepairError('VALIDATION', `Device ${idx + 1}: choose the problem type`, 422)
    const category = i.category ?? 'Smartphone'
    if (!CATEGORIES.includes(category)) throw new RepairError('VALIDATION', `Device ${idx + 1}: unknown device category`, 422)
    const warranty = i.warrantyStatus ?? 'UNKNOWN'
    if (!WARRANTY.includes(warranty)) throw new RepairError('VALIDATION', `Device ${idx + 1}: unknown warranty status`, 422)
    let imei = text(i.imeiSerial, 30).toUpperCase() || null
    if (imei) {
      if (!/^[A-Z0-9-]{5,30}$/.test(imei)) throw new RepairError('VALIDATION', `Device ${idx + 1}: IMEI / serial looks wrong`, 422)
      if (seen.has(imei)) throw new RepairError('VALIDATION', `IMEI / serial ${imei} is listed twice`, 422)
      seen.add(imei)
    }
    return { line_no: idx + 1, category, brand, model, imei, problemCategory, problemDescription: text(i.problemDescription, 1000), warranty, accessories: text(i.accessories, 200) || null }
  })
}

/**
 * @param {{kind:'CUSTOMER'|'ADMIN', userId:string}} actor
 */
export async function createRequest(actor, input = {}) {
  if (actor.kind === 'VENDOR') throw new RepairError('FORBIDDEN', 'Service centres cannot create requests', 403)
  const s = await getSettings()
  if (!s.enabled) throw new RepairError('DISABLED', 'Repair requests are currently switched off', 409)
  const channel = input.channel === 'B2B' ? 'B2B' : 'B2C'
  if (channel === 'B2C' && !s.b2c_enabled) throw new RepairError('CHANNEL_DISABLED', 'Consumer repairs are currently switched off', 409)
  if (channel === 'B2B' && !s.b2b_enabled) throw new RepairError('CHANNEL_DISABLED', 'Business repairs are currently switched off', 409)

  const items = cleanItems(input.items, channel === 'B2B' ? s.max_b2b_devices : s.max_b2c_devices)

  let customer
  if (actor.kind === 'CUSTOMER') {
    const { rows } = await query('SELECT id, name, phone, email FROM users WHERE id = $1 AND is_active = TRUE', [actor.userId])
    if (!rows[0]) throw new RepairError('UNAUTHORIZED', 'Account not found', 401)
    customer = { userId: rows[0].id, name: rows[0].name || 'Customer', phone: rows[0].phone, email: rows[0].email, city: text(input.customer?.city, 100) || null }
  } else {
    const c = input.customer || {}
    if (!text(c.name, 100)) throw new RepairError('VALIDATION', 'Customer name is required', 422)
    if (!PHONE_RE.test(text(c.phone, 20))) throw new RepairError('VALIDATION', 'Customer phone is invalid', 422)
    const phone = text(c.phone, 20)
    const { rows } = await query('SELECT id FROM users WHERE phone = $1 OR phone = $2 LIMIT 1', [phone, phone.replace(/\D/g, '').slice(-10)])
    customer = { userId: rows[0]?.id || null, name: text(c.name, 100), phone, email: text(c.email, 255) || null, city: text(c.city, 100) || null }
  }

  let biz = { businessName: null, gstin: null, poReference: null, contactPerson: null, discount: 0, terms: 0 }
  if (channel === 'B2B') {
    const gstin = text(input.gstin, 15).toUpperCase()
    if (!GSTIN_RE.test(gstin)) throw new RepairError('VALIDATION', 'Enter a valid 15-character GSTIN', 422)
    const businessName = text(input.businessName, 160), contactPerson = text(input.contactPerson, 100)
    if (!businessName) throw new RepairError('VALIDATION', 'Business name is required', 422)
    if (!contactPerson) throw new RepairError('VALIDATION', 'An authorised contact person is required', 422)
    const { rows: t } = await query('SELECT * FROM repair_business_terms WHERE gstin = $1 AND is_active = TRUE', [gstin])
    biz = {
      businessName, gstin, contactPerson, poReference: text(input.poReference, 60) || null,
      discount: num(t[0]?.discount_pct) || 0,
      // Credit terms only apply when a credit limit has been granted.
      terms: t[0] && Number(t[0].credit_limit) > 0 ? t[0].payment_terms_days : 0,
    }
  }

  const mode = input.serviceMode === 'PICKUP' ? 'PICKUP' : 'DROP_OFF'
  const address = text(input.pickupAddress, 500)
  if (mode === 'PICKUP' && address.length < 10) throw new RepairError('VALIDATION', 'Enter the full pickup address', 422)
  let slot = null
  if (input.pickupSlot) {
    slot = new Date(input.pickupSlot)
    if (Number.isNaN(slot.getTime()) || slot.getTime() < Date.now() - 3600_000) throw new RepairError('VALIDATION', 'Pickup time must be in the future', 422)
  }

  // A physical device can only be in one live repair at a time.
  const imeis = items.map((i) => i.imei).filter(Boolean)
  if (imeis.length) {
    const { rows } = await query(
      `SELECT i.imei_serial, r.code FROM repair_items i JOIN repair_requests r ON r.id = i.request_id
        WHERE i.imei_serial = ANY($1) AND r.status <> ALL($2) LIMIT 1`, [imeis, ACTIVE_NOT])
    if (rows[0]) throw new RepairError('DEVICE_ACTIVE', `Device ${rows[0].imei_serial} already has an open repair (${rows[0].code})`, 409)
  }

  const id = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO repair_requests (code, channel, user_id, created_by, created_by_role, customer_name, customer_phone, customer_email, customer_city,
          business_name, gstin, po_reference, contact_person, contract_discount_pct, payment_terms_days, service_mode, pickup_address, pickup_slot,
          description, sla_inspection_due)
       VALUES ('REP-' || nextval('repair_request_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, NOW() + ($19 || ' hours')::interval)
       RETURNING *`,
      [channel, customer.userId, actor.userId, actor.kind, customer.name, customer.phone, customer.email, customer.city,
        biz.businessName, biz.gstin, biz.poReference, biz.contactPerson, biz.discount, biz.terms, mode, mode === 'PICKUP' ? address : null, slot,
        text(input.description, 1000), String(s.sla_inspection_hours)]
    )
    const r = rows[0]
    for (const i of items) {
      await client.query(
        `INSERT INTO repair_items (request_id, line_no, category, brand, model, imei_serial, problem_category, problem_description, warranty_status, accessories)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, i.line_no, i.category, i.brand, i.model, i.imei, i.problemCategory, i.problemDescription, i.warranty, i.accessories])
    }
    await addEvent(client, r.id, 'REQUESTED', channel === 'B2B' ? 'Business repair request submitted' : 'Repair request submitted', actor, { to: 'REQUESTED', meta: { devices: items.length } })
    if (Array.isArray(input.mediaIds) && input.mediaIds.length) await claimRepairMedia(client, r, actor, input.mediaIds, 'CUSTOMER_SUBMISSION')
    return r.id
  })
  return getManage({ kind: 'ADMIN' }, id)
}

// ── reads ───────────────────────────────────────────────────────────────

function sla(r) {
  const now = Date.now()
  const inspection = ['REQUESTED', 'ACCEPTED'].includes(r.status) && r.sla_inspection_due && r.sla_inspection_due.getTime() < now
  const repair = ['ESTIMATE_APPROVED', 'IN_REPAIR', 'QC_PENDING'].includes(r.status) && r.sla_repair_due && r.sla_repair_due.getTime() < now
  return { inspectionDue: r.sla_inspection_due?.toISOString() ?? null, repairDue: r.sla_repair_due?.toISOString() ?? null, breached: !!(inspection || repair) }
}

function serialize(r, { actor, items = [], quotes = [], payments = [], events = [], media = [] } = {}) {
  const customerView = actor?.kind === 'CUSTOMER'
  const today = new Date().toISOString().slice(0, 10)
  const due = amountDue(r)
  const out = {
    id: r.id, code: r.code, channel: r.channel, status: r.status, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    customer: { name: r.customer_name, phone: r.customer_phone, email: r.customer_email || '', city: r.customer_city || '—' },
    business: r.channel === 'B2B' ? { name: r.business_name, gstin: r.gstin, poReference: r.po_reference, contactPerson: r.contact_person, contractDiscountPct: num(r.contract_discount_pct), paymentTermsDays: r.payment_terms_days } : null,
    serviceMode: r.service_mode, pickupAddress: r.pickup_address, pickupSlot: r.pickup_slot?.toISOString() ?? null,
    description: r.description,
    serviceCenterId: r.assigned_vendor_id, serviceCenter: r.vendor_name || null, technician: r.technician_name || null,
    deviceReceivedAt: r.device_received_at?.toISOString() ?? null,
    money: {
      approvedTotal: num(r.approved_total), advanceRequired: num(r.advance_required), amountPaid: num(r.amount_paid), amountDue: due,
      refundable: refundable(r), dueDate: ymd(r.due_date),
      overdue: !!(r.due_date && ymd(r.due_date) < today && due > 0),
    },
    warrantyUntil: ymd(r.warranty_until),
    reworkCount: r.rework_count, reopenedCount: r.reopened_count,
    sla: sla(r),
    deviceCount: Number(r.device_count ?? items.length), deliveredCount: Number(r.delivered_count ?? items.filter((i) => i.delivered_at).length),
    note: r.decision_note || undefined,
    items: items.map((i) => ({
      id: i.id, lineNo: i.line_no, category: i.category, brand: i.brand, model: i.model, imeiSerial: i.imei_serial, problemCategory: i.problem_category,
      problemDescription: i.problem_description, warrantyStatus: i.warranty_status, accessories: i.accessories, status: i.item_status,
      diagnosis: i.diagnosis, qcPassed: i.qc_passed, qcNotes: i.qc_notes, deliveredAt: i.delivered_at?.toISOString() ?? null,
    })),
    quotes: quotes.map((q) => ({
      id: q.id, version: q.version, status: q.status, lines: q.lines, subtotal: num(q.subtotal), discountPct: num(q.discount_pct), discountAmount: num(q.discount_amount),
      taxable: num(q.taxable), taxPct: num(q.tax_pct), taxAmount: num(q.tax_amount), total: num(q.total), note: q.note,
      validUntil: q.valid_until.toISOString(), expired: q.status === 'SENT' && q.valid_until.getTime() < Date.now(), createdAt: q.created_at.toISOString(),
    })),
    payments: payments.map((p) => ({ id: p.id, kind: p.kind, method: p.method, amount: num(p.amount), reference: p.reference, note: p.note, at: p.created_at.toISOString() })),
    timeline: events.map((e) => ({ kind: e.kind, label: e.label, at: e.created_at.toISOString(), from: e.from_status, to: e.to_status })),
    media,
  }
  if (!customerView) out.settlement = r.commission_amount != null ? { commissionPct: num(r.commission_pct), commission: num(r.commission_amount), vendorPayable: num(r.vendor_payable) } : null
  return out
}

const SELECT = `
  SELECT r.*, v.name AS vendor_name,
         (SELECT COUNT(*) FROM repair_items i WHERE i.request_id = r.id) AS device_count,
         (SELECT COUNT(*) FROM repair_items i WHERE i.request_id = r.id AND i.delivered_at IS NOT NULL) AS delivered_count
    FROM repair_requests r LEFT JOIN vendors v ON v.id = r.assigned_vendor_id`

function scope(actor, params) {
  if (actor.kind === 'ADMIN') return 'TRUE'
  if (actor.kind === 'CUSTOMER') { params.push(actor.userId); return `r.user_id = $${params.length}` }
  params.push(actor.vendorId || null)
  return `r.assigned_vendor_id = $${params.length}`
}

async function loadDetail(r, actor) {
  const [items, quotes, payments, events, media] = await Promise.all([
    query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no', [r.id]),
    query('SELECT * FROM repair_quotes WHERE request_id = $1 ORDER BY version DESC', [r.id]),
    actor.kind === 'VENDOR' ? { rows: [] } : query('SELECT * FROM repair_payments WHERE request_id = $1 ORDER BY created_at, id', [r.id]),
    query('SELECT * FROM repair_events WHERE request_id = $1 ORDER BY id', [r.id]),
    listRepairMedia(r.id),
  ])
  return serialize(r, { actor, items: items.rows, quotes: quotes.rows, payments: payments.rows, events: events.rows, media })
}

export async function getManage(actor, id) {
  const params = [id]
  const sc = scope(actor, params)
  const { rows } = await query(`${SELECT} WHERE r.id = $1 AND ${sc}`, params)
  if (!rows[0]) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  return loadDetail(rows[0], actor)
}

export const getMine = (userId, id) => getManage({ kind: 'CUSTOMER', userId }, id)

export async function list(actor, f = {}) {
  const params = []
  const where = [scope(actor, params)]
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }
  if (f.channel === 'B2B' || f.channel === 'B2C') add('r.channel = ?', f.channel)
  if (f.vendorId && actor.kind === 'ADMIN') add('r.assigned_vendor_id = ?', f.vendorId)
  if (f.overdue) where.push(`r.due_date < CURRENT_DATE AND r.approved_total > r.amount_paid`)
  if (f.q) {
    params.push(`%${String(f.q).slice(0, 100)}%`)
    where.push(`((r.code || ' ' || r.customer_name || ' ' || r.customer_phone || ' ' || COALESCE(r.business_name,'') || ' ' || COALESCE(r.po_reference,'')) ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM repair_items i WHERE i.request_id = r.id AND (i.imei_serial ILIKE $${params.length} OR i.model ILIKE $${params.length})))`)
  }
  const base = where.join(' AND ')
  const { rows: cnt } = await query(`SELECT r.status, COUNT(*)::int AS n FROM repair_requests r WHERE ${base} GROUP BY r.status`, params)
  const byStatus = Object.fromEntries(cnt.map((c) => [c.status, c.n]))
  const counts = { all: cnt.reduce((n, c) => n + c.n, 0) }
  for (const [tab, sts] of Object.entries(TABS)) counts[tab] = sts.reduce((n, s) => n + (byStatus[s] || 0), 0)

  const tab = f.tab && f.tab !== 'all' ? TABS[f.tab] : null
  if (f.tab && f.tab !== 'all' && !tab) throw new RepairError('VALIDATION', 'Unknown queue', 422)
  const limit = Math.min(100, Math.max(1, Number(f.limit) || 20))
  const total = tab ? counts[f.tab] : counts.all
  const pages = Math.max(1, Math.ceil(total / limit))
  const page = Math.min(Math.max(1, Number(f.page) || 1), pages)
  const lp = [...params]
  let st = ''
  if (tab) { lp.push(tab); st = ` AND r.status = ANY($${lp.length})` }
  lp.push(limit, (page - 1) * limit)
  const { rows } = await query(`${SELECT} WHERE ${base}${st} ORDER BY r.created_at DESC, r.id DESC LIMIT $${lp.length - 1} OFFSET $${lp.length}`, lp)
  const ids = rows.map((r) => r.id)
  const { rows: first } = ids.length ? await query(`SELECT DISTINCT ON (request_id) request_id, brand, model FROM repair_items WHERE request_id = ANY($1) ORDER BY request_id, line_no`, [ids]) : { rows: [] }
  const firstBy = new Map(first.map((i) => [i.request_id, i]))
  return {
    items: rows.map((r) => ({ ...serialize(r, { actor }), firstDevice: firstBy.has(r.id) ? `${firstBy.get(r.id).brand} ${firstBy.get(r.id).model}` : null })),
    total, page, pages, counts,
  }
}

export async function stats(actor) {
  const params = []
  const sc = scope(actor, params)
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE r.channel = 'B2B')::int AS b2b, COUNT(*) FILTER (WHERE r.channel = 'B2C')::int AS b2c,
            COUNT(*) FILTER (WHERE r.status = ANY('{ACCEPTED,INSPECTION,ESTIMATE_SENT,ESTIMATE_APPROVED,IN_REPAIR,QC_PENDING,REPAIRED,READY_FOR_DELIVERY}'))::int AS open,
            COUNT(*) FILTER (WHERE r.status = 'ESTIMATE_SENT')::int AS awaiting_approval,
            COUNT(*) FILTER (WHERE r.status IN ('FAILED','ESTIMATE_REJECTED') OR r.rework_count > 0 AND r.status <> 'COMPLETED')::int AS problems,
            COUNT(*) FILTER (WHERE (r.status IN ('REQUESTED','ACCEPTED') AND r.sla_inspection_due < NOW()) OR (r.status IN ('ESTIMATE_APPROVED','IN_REPAIR','QC_PENDING') AND r.sla_repair_due < NOW()))::int AS sla_breached,
            COALESCE(SUM(GREATEST(r.approved_total - r.amount_paid, 0)) FILTER (WHERE r.status NOT IN ('REJECTED','CANCELLED')), 0) AS outstanding,
            COUNT(*) FILTER (WHERE r.due_date < CURRENT_DATE AND r.approved_total > r.amount_paid)::int AS overdue,
            COALESCE(SUM(r.approved_total) FILTER (WHERE r.status = 'COMPLETED' AND r.completed_at >= date_trunc('month', NOW())), 0) AS completed_value_month
       FROM repair_requests r WHERE ${sc}`, params)
  const x = rows[0]
  return { total: x.total, b2b: x.b2b, b2c: x.b2c, open: x.open, awaitingApproval: x.awaiting_approval, problems: x.problems, slaBreached: x.sla_breached, outstanding: Number(x.outstanding), overdue: x.overdue, completedValueMonth: Number(x.completed_value_month) }
}

// ── lifecycle ───────────────────────────────────────────────────────────

async function checkVendor(client, vendorId, technicianId) {
  const { rows } = await client.query(`SELECT id, name FROM vendors WHERE id = $1 AND is_active AND status IN ('VERIFIED','ACTIVE') AND deleted_at IS NULL`, [vendorId])
  if (!rows[0]) throw new RepairError('VALIDATION', 'Choose an active service centre', 422)
  let tech = null
  if (technicianId) {
    const { rows: t } = await client.query(
      `SELECT u.id, u.name FROM vendor_users vu JOIN users u ON u.id = vu.user_id WHERE vu.vendor_id = $1 AND vu.user_id = $2 AND vu.is_active AND vu.deleted_at IS NULL`, [vendorId, technicianId])
    if (!t[0]) throw new RepairError('VALIDATION', 'That technician does not belong to the chosen service centre', 422)
    tech = t[0]
  }
  return { vendor: rows[0], tech }
}

export const accept = (actor, id, { vendorId, technicianId } = {}) => tx(async (client) => {
  platformOnly(actor)
  const r = await lock(client, id, actor)
  const cols = {}
  let label = 'Request accepted'
  if (vendorId) {
    const { vendor, tech } = await checkVendor(client, vendorId, technicianId)
    Object.assign(cols, { assigned_vendor_id: vendor.id, technician_id: tech?.id ?? null, technician_name: tech?.name ?? null })
    label += ` — assigned to ${vendor.name}`
  }
  await moveTo(client, r, 'ACCEPTED', actor, label, cols)
}).then(() => { notifyRepair('ACCEPTED', id); return getManage(actor, id) })

export const reject = (actor, id, reason) => tx(async (client) => {
  platformOnly(actor)
  const note = text(reason, 500)
  if (!note) throw new RepairError('VALIDATION', 'A reason is required', 422)
  const r = await lock(client, id, actor)
  await moveTo(client, r, 'REJECTED', actor, 'Request rejected', { decision_note: note }, { reason: note })
  return note
}).then((note) => { notifyRepair('REJECTED', id, { reason: note }); return getManage(actor, id) })

export const assign = (actor, id, { vendorId, technicianId }) => tx(async (client) => {
  platformOnly(actor)
  const r = await lock(client, id, actor)
  if (['REJECTED', 'CANCELLED', 'COMPLETED'].includes(r.status)) throw new RepairError('INVALID_STATE', 'This repair is closed', 409)
  const { vendor, tech } = await checkVendor(client, vendorId, technicianId)
  await patch(client, id, { assigned_vendor_id: vendor.id, technician_id: tech?.id ?? null, technician_name: tech?.name ?? null })
  await addEvent(client, id, 'ASSIGNED', `Assigned to ${vendor.name}${tech ? ` · ${tech.name}` : ''}`, actor, { meta: { vendorId: vendor.id, technicianId: tech?.id } })
}).then(() => getManage(actor, id))

export const cancel = (actor, id, reason) => tx(async (client) => {
  const note = text(reason, 500)
  if (!note) throw new RepairError('VALIDATION', 'A reason is required', 422)
  if (actor.kind === 'VENDOR') throw new RepairError('FORBIDDEN', 'Service centres cannot cancel requests', 403)
  const r = await lock(client, id, actor)
  // Once the device has arrived it must go back through an estimate rejection or a failure, so nothing is lost.
  await moveTo(client, r, 'CANCELLED', actor, 'Request cancelled', { decision_note: note }, { reason: note })
}).then(() => { notifyRepair('CANCELLED', id, { skipCustomer: actor.kind === 'CUSTOMER' }); return getManage(actor, id) })

export const receiveDevice = (actor, id) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  if (!r.assigned_vendor_id) throw new RepairError('NO_SERVICE_CENTER', 'Assign a service centre before receiving the device', 409)
  await moveTo(client, r, 'INSPECTION', actor, r.service_mode === 'PICKUP' ? 'Device picked up — inspection started' : 'Device received — inspection started', { device_received_at: new Date() })
}).then(() => getManage(actor, id))

export const setDiagnosis = (actor, id, itemId, { diagnosis, repairable }) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  if (!['INSPECTION', 'IN_REPAIR'].includes(r.status)) throw new RepairError('INVALID_STATE', 'Diagnosis can only be recorded during inspection or repair', 409)
  const d = text(diagnosis, 2000)
  if (!d) throw new RepairError('VALIDATION', 'Describe what you found', 422)
  const { rows } = await client.query('SELECT * FROM repair_items WHERE id = $1 AND request_id = $2 FOR UPDATE', [itemId, id])
  if (!rows[0]) throw new RepairError('NOT_FOUND', 'Device not found on this request', 404)
  const status = repairable === false ? 'FAILED' : 'PENDING'
  await client.query('UPDATE repair_items SET diagnosis = $2, item_status = $3 WHERE id = $1', [itemId, d, status])
  await addEvent(client, id, 'DIAGNOSIS', `Diagnosis recorded for ${rows[0].brand} ${rows[0].model}${repairable === false ? ' (not repairable)' : ''}`, actor, { meta: { itemId } })
}).then(() => getManage(actor, id))

/** Validate quote lines and make sure every repairable device is priced. */
async function cleanLines(client, requestId, raw) {
  if (!Array.isArray(raw) || !raw.length) throw new RepairError('VALIDATION', 'Add at least one line to the estimate', 422)
  if (raw.length > 400) throw new RepairError('VALIDATION', 'Too many lines in one estimate', 422)
  const { rows: items } = await client.query('SELECT id, item_status FROM repair_items WHERE request_id = $1', [requestId])
  const byId = new Map(items.map((i) => [i.id, i]))
  const lines = raw.map((l, n) => {
    const kind = l.kind
    if (!LINE_KINDS.includes(kind)) throw new RepairError('VALIDATION', `Line ${n + 1}: choose labour, part, diagnostic or other`, 422)
    const description = text(l.description, 200)
    if (description.length < 2) throw new RepairError('VALIDATION', `Line ${n + 1}: add a description`, 422)
    const qty = Number(l.qty ?? 1), unit = Number(l.unitPrice)
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new RepairError('VALIDATION', `Line ${n + 1}: quantity must be a whole number from 1 to 1000`, 422)
    if (!Number.isFinite(unit) || unit < 0 || unit > 1_000_000 || Math.abs(Math.round(unit * 100) / 100 - unit) > 1e-9) throw new RepairError('VALIDATION', `Line ${n + 1}: price must be between 0 and 10,00,000 with at most 2 decimals`, 422)
    if (l.itemId != null && !byId.has(l.itemId)) throw new RepairError('VALIDATION', `Line ${n + 1}: that device is not on this request`, 422)
    return { itemId: l.itemId ?? null, kind, description, qty, unitPrice: Math.round(unit * 100) / 100, serviceCode: l.serviceCode ? text(l.serviceCode, 40) : undefined }
  })
  const priced = new Set(lines.filter((l) => l.kind !== 'DIAGNOSTIC' && l.itemId).map((l) => l.itemId))
  const missing = items.filter((i) => i.item_status === 'PENDING' && !priced.has(i.id))
  if (missing.length) throw new RepairError('UNPRICED_DEVICE', `${missing.length} device${missing.length === 1 ? ' has' : 's have'} no repair line in this estimate`, 422, { itemIds: missing.map((m) => m.id) })
  return lines
}

export const createQuote = (actor, id, { lines, note } = {}) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  if (!['INSPECTION', 'ESTIMATE_SENT'].includes(r.status)) throw new RepairError('INVALID_STATE', 'An estimate can only be sent during inspection (or revised while awaiting approval)', 409)
  const s = await getSettings(client)
  const clean = await cleanLines(client, id, lines)
  const q = computeQuote({ lines: clean, discountPct: Number(r.contract_discount_pct) || 0, taxPct: Number(s.tax_pct) })
  await client.query(`UPDATE repair_quotes SET status = 'SUPERSEDED' WHERE request_id = $1 AND status = 'SENT'`, [id])
  const { rows: v } = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM repair_quotes WHERE request_id = $1', [id])
  await client.query(
    `INSERT INTO repair_quotes (request_id, version, lines, subtotal, discount_pct, discount_amount, taxable, tax_pct, tax_amount, total, note, valid_until, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + ($12 || ' days')::interval, $13)`,
    [id, v[0].v, JSON.stringify(q.lines), q.subtotal, q.discountPct, q.discountAmount, q.taxable, q.taxPct, q.taxAmount, q.total, text(note, 1000) || null, String(s.estimate_validity_days), actor.userId])
  if (r.status === 'INSPECTION') await moveTo(client, r, 'ESTIMATE_SENT', actor, `Estimate sent — ₹${q.total}`, {}, { total: q.total, version: v[0].v })
  else await addEvent(client, id, 'ESTIMATE_REVISED', `Estimate revised (v${v[0].v}) — ₹${q.total}`, actor, { meta: { total: q.total } })
  return q.total
}).then((total) => { notifyRepair('ESTIMATE_SENT', id, { total }); return getManage(actor, id) })

async function creditCheck(client, r, total) {
  if (!(r.payment_terms_days > 0) || !r.gstin) return
  const { rows: t } = await client.query('SELECT credit_limit FROM repair_business_terms WHERE gstin = $1 AND is_active = TRUE', [r.gstin])
  const limit = Number(t[0]?.credit_limit || 0)
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(GREATEST(approved_total - amount_paid, 0)), 0) AS out FROM repair_requests
      WHERE gstin = $1 AND id <> $2 AND status NOT IN ('REJECTED','CANCELLED','ESTIMATE_REJECTED','FAILED')`, [r.gstin, r.id])
  const outstanding = Number(rows[0].out)
  if (outstanding + total > limit) {
    throw new RepairError('CREDIT_LIMIT', `Approving this would exceed the business's credit limit (outstanding ₹${outstanding}, limit ₹${limit})`, 409, { outstanding, limit })
  }
}

/** Customer approves their estimate; a platform user may approve on a business's behalf with a written reference. */
export const approveEstimate = (actor, id, { note } = {}) => tx(async (client) => {
  if (actor.kind === 'VENDOR') throw new RepairError('FORBIDDEN', 'Only the customer or platform staff can approve an estimate', 403)
  const r = await lock(client, id, actor)
  const onBehalf = actor.kind === 'ADMIN'
  const ref = text(note, 300)
  if (onBehalf && ref.length < 3) throw new RepairError('VALIDATION', 'Record who approved (name / email / PO) when approving on the customer’s behalf', 422)
  const { rows } = await client.query(`SELECT * FROM repair_quotes WHERE request_id = $1 AND status = 'SENT' FOR UPDATE`, [id])
  const q = rows[0]
  if (r.status !== 'ESTIMATE_SENT' || !q) throw new RepairError('INVALID_STATE', 'There is no estimate waiting for approval', 409)
  if (q.valid_until.getTime() < Date.now()) throw new RepairError('QUOTE_EXPIRED', 'This estimate has expired — ask the service centre to send a new one', 409)
  const s = await getSettings(client)
  const total = Number(q.total)
  await creditCheck(client, r, total)
  const advance = !s.require_advance || r.payment_terms_days > 0 ? 0 : advanceFor(total, Number(s.advance_pct))
  await client.query(`UPDATE repair_quotes SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $1`, [q.id, actor.userId, ref || null])
  await moveTo(client, r, 'ESTIMATE_APPROVED', actor, onBehalf ? `Estimate approved on customer’s behalf (${ref})` : 'Estimate approved', { approved_quote_id: q.id, approved_total: total, advance_required: advance }, { total, advance })
}).then(() => getManage(actor, id))

/** Diagnostic fee for devices that are not in warranty (platform setting). */
async function diagnosticDue(client, r) {
  const s = await getSettings(client)
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM repair_items WHERE request_id = $1 AND warranty_status <> 'IN_WARRANTY'`, [r.id])
  return money.rupees(rows[0].n * money.paise(s.diagnostic_fee))
}

export const rejectEstimate = (actor, id, reason) => tx(async (client) => {
  if (actor.kind === 'VENDOR') throw new RepairError('FORBIDDEN', 'Only the customer or platform staff can reject an estimate', 403)
  const note = text(reason, 500)
  if (!note) throw new RepairError('VALIDATION', 'A reason is required', 422)
  const r = await lock(client, id, actor)
  const fee = await diagnosticDue(client, r)
  await client.query(`UPDATE repair_quotes SET status = 'REJECTED', decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE request_id = $1 AND status IN ('SENT','APPROVED')`, [id, actor.userId, note])
  await moveTo(client, r, 'ESTIMATE_REJECTED', actor, 'Estimate rejected — device to be returned', { approved_total: fee, advance_required: 0, decision_note: note }, { reason: note, diagnosticFee: fee })
}).then(() => getManage(actor, id))

export const startRepair = (actor, id) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  if (r.status === 'ESTIMATE_APPROVED' && money.paise(r.amount_paid) < money.paise(r.advance_required)) {
    throw new RepairError('ADVANCE_REQUIRED', `Collect the advance of ₹${r.advance_required} before starting (paid ₹${r.amount_paid})`, 409, { required: num(r.advance_required), paid: num(r.amount_paid) })
  }
  const s = await getSettings(client)
  await moveTo(client, r, 'IN_REPAIR', actor, 'Repair started', { sla_repair_due: new Date(Date.now() + s.sla_repair_hours * 3600_000) })
}).then(() => { notifyRepair('IN_REPAIR', id); return getManage(actor, id) })

export const sendToQc = (actor, id) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  await moveTo(client, r, 'QC_PENDING', actor, 'Repair done — waiting for final QC')
}).then(() => getManage(actor, id))

/** Final QC per device. All pass → REPAIRED; any fail → back to IN_REPAIR as rework. */
export const finalQc = (actor, id, { results, note } = {}) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  if (r.status !== 'QC_PENDING') throw new RepairError('INVALID_STATE', 'This repair is not waiting for QC', 409)
  const { rows: pending } = await client.query(`SELECT * FROM repair_items WHERE request_id = $1 AND item_status = 'PENDING' FOR UPDATE`, [id])
  const res = new Map((Array.isArray(results) ? results : []).map((x) => [x.itemId, x]))
  if (pending.some((i) => !res.has(i.id)) || res.size !== pending.length) throw new RepairError('VALIDATION', 'Record a QC result for every device being repaired', 422)
  let failed = 0
  for (const i of pending) {
    const x = res.get(i.id)
    if (typeof x.passed !== 'boolean') throw new RepairError('VALIDATION', 'Each QC result must be pass or fail', 422)
    if (!x.passed && !text(x.notes, 500)) throw new RepairError('VALIDATION', `Say what failed on ${i.brand} ${i.model}`, 422)
    if (!x.passed) failed++
  }
  for (const i of pending) {
    const x = res.get(i.id)
    await client.query('UPDATE repair_items SET qc_passed = $2, qc_notes = $3, item_status = $4 WHERE id = $1', [i.id, x.passed, text(x.notes, 500) || null, x.passed ? 'REPAIRED' : 'PENDING'])
  }
  if (!failed) await moveTo(client, r, 'REPAIRED', actor, 'Final QC passed', {}, { note: text(note, 500) || undefined })
  else await moveTo(client, r, 'IN_REPAIR', actor, `QC failed on ${failed} device${failed === 1 ? '' : 's'} — rework`, { rework_count: r.rework_count + 1 }, { failed })
}).then(() => { notifyRepair('REPAIRED', id); return getManage(actor, id) })

/** The device cannot be repaired. Customer owes only the diagnostic fee (devices in warranty are free). */
export const markFailed = (actor, id, reason) => tx(async (client) => {
  staffOnly(actor)
  const note = text(reason, 500)
  if (!note) throw new RepairError('VALIDATION', 'A reason is required', 422)
  const r = await lock(client, id, actor)
  const fee = await diagnosticDue(client, r)
  await client.query(`UPDATE repair_items SET item_status = 'FAILED' WHERE request_id = $1 AND item_status = 'PENDING'`, [id])
  await client.query(`UPDATE repair_quotes SET status = 'REJECTED', decision_note = 'Device could not be repaired', decided_at = NOW() WHERE request_id = $1 AND status IN ('SENT','APPROVED')`, [id])
  await moveTo(client, r, 'FAILED', actor, 'Repair failed — device to be returned', { approved_total: fee, advance_required: 0, decision_note: note }, { reason: note, diagnosticFee: fee })
  return note
}).then((note) => { notifyRepair('FAILED', id, { reason: note }); return getManage(actor, id) })

export const markReady = (actor, id) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  await moveTo(client, r, 'READY_FOR_DELIVERY', actor, r.service_mode === 'PICKUP' ? 'Ready for delivery' : 'Ready for pickup')
}).then(() => { notifyRepair('READY_FOR_DELIVERY', id); return getManage(actor, id) })

/**
 * Hand devices back. B2B may deliver in parts; the request completes when every device is delivered.
 * Delivery is blocked while money is outstanding, unless the business has approved credit terms.
 */
export const deliver = (actor, id, { itemIds } = {}) => tx(async (client) => {
  staffOnly(actor)
  const r = await lock(client, id, actor)
  if (r.status !== 'READY_FOR_DELIVERY') throw new RepairError('INVALID_STATE', 'Mark the repair ready for delivery first', 409)
  const { rows: all } = await client.query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no FOR UPDATE', [id])
  const open = all.filter((i) => !i.delivered_at)
  const chosen = Array.isArray(itemIds) && itemIds.length ? open.filter((i) => itemIds.includes(i.id)) : open
  if (!chosen.length || (Array.isArray(itemIds) && itemIds.length && chosen.length !== new Set(itemIds).size)) throw new RepairError('VALIDATION', 'Choose devices that are still waiting to be delivered', 422)
  if (chosen.length < open.length && r.channel !== 'B2B') throw new RepairError('VALIDATION', 'Consumer repairs are delivered in one go', 422)

  const repairedPath = all.some((i) => i.item_status === 'REPAIRED')
  const onCredit = repairedPath && r.payment_terms_days > 0
  if (!onCredit && amountDue(r) > 0) throw new RepairError('PAYMENT_DUE', `₹${amountDue(r)} is still due — record the payment before delivery`, 409, { due: amountDue(r) })
  if (refundable(r) > 0) throw new RepairError('REFUND_PENDING', `₹${refundable(r)} was paid in excess and must be refunded first`, 409, { refundable: refundable(r) })

  await client.query('UPDATE repair_items SET delivered_at = NOW() WHERE id = ANY($1)', [chosen.map((c) => c.id)])
  const remaining = open.length - chosen.length
  if (remaining > 0) {
    await patch(client, id, {})
    await addEvent(client, id, 'PARTIAL_DELIVERY', `Delivered ${chosen.length} of ${all.length} devices`, actor, { meta: { itemIds: chosen.map((c) => c.id), remaining } })
    return { completed: false }
  }
  const s = await getSettings(client)
  const cols = { completed_at: new Date() }
  if (repairedPath) {
    cols.warranty_until = warrantyUntil(new Date(), s.default_warranty_days)
    if (r.approved_quote_id) {
      const { rows: q } = await client.query('SELECT taxable FROM repair_quotes WHERE id = $1', [r.approved_quote_id])
      const st = settle({ taxable: q[0].taxable, commissionPct: Number(s.platform_commission_pct) })
      Object.assign(cols, { commission_pct: s.platform_commission_pct, commission_amount: st.commission, vendor_payable: st.vendorPayable })
    }
    if (r.payment_terms_days > 0) cols.due_date = new Date(Date.now() + r.payment_terms_days * 86400_000).toISOString().slice(0, 10)
  }
  await moveTo(client, r, 'COMPLETED', actor, 'Delivered — repair completed', cols, { devices: chosen.length })
  return { completed: true }
}).then((o) => { if (o.completed) notifyRepair('COMPLETED', id); return getManage(actor, id) })

/** Warranty claim: bring a finished repair back for rework at no charge. */
export const reopen = (actor, id, { reason, itemIds } = {}) => tx(async (client) => {
  if (actor.kind === 'VENDOR') throw new RepairError('FORBIDDEN', 'Raise warranty claims through platform support', 403)
  const note = text(reason, 500)
  if (!note) throw new RepairError('VALIDATION', 'Describe the problem', 422)
  const r = await lock(client, id, actor)
  if (r.status !== 'COMPLETED') throw new RepairError('INVALID_STATE', 'Only completed repairs can be reopened', 409)
  if (!r.warranty_until || ymd(r.warranty_until) < new Date().toISOString().slice(0, 10)) throw new RepairError('WARRANTY_EXPIRED', 'The warranty on this repair has ended', 409)
  const { rows: items } = await client.query(`SELECT id FROM repair_items WHERE request_id = $1 AND item_status = 'REPAIRED'`, [id])
  const ids = Array.isArray(itemIds) && itemIds.length ? items.filter((i) => itemIds.includes(i.id)).map((i) => i.id) : items.map((i) => i.id)
  if (!ids.length) throw new RepairError('VALIDATION', 'Choose a repaired device to reopen', 422)
  const s = await getSettings(client)
  await client.query(`UPDATE repair_items SET item_status = 'PENDING', qc_passed = NULL, qc_notes = NULL, delivered_at = NULL WHERE id = ANY($1)`, [ids])
  await moveTo(client, r, 'IN_REPAIR', actor, 'Warranty claim — reopened for rework', {
    reopened_count: r.reopened_count + 1, completed_at: null, decision_note: note, sla_repair_due: new Date(Date.now() + s.sla_repair_hours * 3600_000),
  }, { reason: note, itemIds: ids })
}).then(() => getManage(actor, id))

// ── payments ────────────────────────────────────────────────────────────

/**
 * Record money received or refunded. Idempotent per (request, idempotencyKey): replaying the same call
 * returns the original result and changes nothing.
 */
export const recordPayment = (actor, id, input = {}) => tx(async (client) => {
  platformOnly(actor)
  const { kind, method } = input
  if (!PAY_KINDS.includes(kind)) throw new RepairError('VALIDATION', 'Unknown payment type', 422)
  if (!METHODS.includes(method)) throw new RepairError('VALIDATION', 'Unknown payment method', 422)
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000 || Math.abs(Math.round(amount * 100) / 100 - amount) > 1e-9) throw new RepairError('VALIDATION', 'Amount must be above zero with at most 2 decimals', 422)
  const key = text(input.idempotencyKey, 80)
  if (key.length < 8) throw new RepairError('VALIDATION', 'idempotencyKey (8–80 characters) is required', 422)
  const r = await lock(client, id, actor)

  const { rows: dup } = await client.query('SELECT 1 FROM repair_payments WHERE request_id = $1 AND idempotency_key = $2', [id, key])
  if (dup[0]) return { duplicate: true }

  const note = text(input.note, 300) || null
  if (kind === 'REFUND') {
    if (!note) throw new RepairError('VALIDATION', 'A reason is required for a refund', 422)
    if (money.paise(amount) > money.paise(refundable(r))) throw new RepairError('REFUND_TOO_HIGH', `Only ₹${refundable(r)} is refundable`, 409, { refundable: refundable(r) })
  } else {
    if (['REQUESTED', 'ACCEPTED', 'INSPECTION', 'ESTIMATE_SENT', 'REJECTED', 'CANCELLED'].includes(r.status)) {
      throw new RepairError('INVALID_STATE', 'Payments open once an estimate is approved', 409)
    }
    if (money.paise(amount) > money.paise(amountDue(r))) throw new RepairError('OVERPAYMENT', `Only ₹${amountDue(r)} is due`, 409, { due: amountDue(r) })
  }
  await client.query(
    `INSERT INTO repair_payments (request_id, kind, method, amount, reference, idempotency_key, recorded_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, kind, method, amount, text(input.reference, 80) || null, key, actor.userId, note])
  const delta = kind === 'REFUND' ? -amount : amount
  await client.query('UPDATE repair_requests SET amount_paid = amount_paid + $2, updated_at = NOW() WHERE id = $1', [id, delta])
  await addEvent(client, id, 'PAYMENT', `${kind === 'REFUND' ? 'Refunded' : 'Received'} ₹${amount} (${method.toLowerCase()})`, actor, { meta: { kind, method, amount } })
  return { duplicate: false }
}).then((o) => getManage(actor, id).then((r) => ({ ...r, duplicate: o.duplicate })))
