/**
 * Request-level QC for sell/exchange requests.
 *
 * This is NOT listing QC (`modules/qc`, keyed by shop_product_id). It follows one customer's device
 * through inspection to a final valuation and the customer's decision:
 *
 *   AWAITING_EVIDENCE → EVIDENCE_UPLOADED → INSPECTION_PENDING → INSPECTION_COMPLETE
 *        → PASSED | RECHECK | FAILED      (RECHECK → INSPECTION_PENDING;  FAILED/PASSED → RECHECK on reopen)
 *   PASSED → customer ACCEPTS / DECLINES the final valuation.
 *
 * The existing request status (PENDING … COMPLETED) is untouched; the optional gate
 * `sell_settings.qc_required_for_approval` ties approval/completion to this process.
 * Every transition is checked here, takes the request row lock, and writes an append-only history row.
 *
 * @module modules/sell-requests/request-qc.service
 */
import { query } from '../../config/database.js'
import { SellError, addEvent, cancel, lock, tx } from './sell-requests.service.js'
import { notifySellEvent } from './sell-requests.notify.js'

export const QC_TRANSITIONS = Object.freeze({
  AWAITING_EVIDENCE: ['EVIDENCE_UPLOADED'],
  EVIDENCE_UPLOADED: ['INSPECTION_PENDING'],
  INSPECTION_PENDING: ['INSPECTION_COMPLETE'],
  INSPECTION_COMPLETE: ['PASSED', 'RECHECK', 'FAILED'],
  RECHECK: ['INSPECTION_PENDING'],
  FAILED: ['RECHECK'],
  PASSED: ['RECHECK'],
})

const PHYSICAL = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR']
const SCREEN = ['FLAWLESS', 'MINOR_SCRATCHES', 'MAJOR_SCRATCHES', 'CRACKED', 'DEAD_PIXELS']
const CLOSED = ['REJECTED', 'CANCELLED', 'COMPLETED']
const FUNC_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,29}$/

const num = (v) => (v == null ? null : Number(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)

function serializeQc(q, history = []) {
  if (!q) return { status: 'NOT_STARTED', customerDecision: 'NONE', history: [] }
  return {
    status: q.status,
    inspectorId: q.inspector_id,
    inspectorName: q.inspector_name || null,
    physicalCondition: q.physical_condition,
    imeiVerified: q.imei_verified,
    imeiObserved: q.imei_observed,
    screenCondition: q.screen_condition,
    batteryHealth: q.battery_health,
    functionality: q.functionality || {},
    remarks: q.remarks,
    finalValuation: num(q.final_valuation),
    customerDecision: q.customer_decision,
    customerDecidedAt: q.customer_decided_at?.toISOString() ?? null,
    inspectedAt: q.inspected_at?.toISOString() ?? null,
    decidedAt: q.decided_at?.toISOString() ?? null,
    updatedAt: q.updated_at.toISOString(),
    history: history.map((h) => ({
      at: h.created_at.toISOString(), action: h.action, from: h.from_status, to: h.to_status,
      note: h.note || undefined, actorRole: h.actor_role, actorName: h.actor_name || undefined, meta: h.meta,
    })),
  }
}

const QC_SELECT = `SELECT q.*, u.name AS inspector_name FROM sell_request_qc q LEFT JOIN users u ON u.id = q.inspector_id`

export async function getQc(requestId, { forCustomer = false } = {}) {
  const { rows } = await query(`${QC_SELECT} WHERE q.request_id = $1`, [requestId])
  const { rows: hist } = await query(
    `SELECT h.*, u.name AS actor_name FROM sell_request_qc_events h LEFT JOIN users u ON u.id = h.actor_id WHERE h.request_id = $1 ORDER BY h.id`, [requestId]
  )
  const out = serializeQc(rows[0], hist)
  if (forCustomer) {
    // Customers see the outcome and valuation, not the inspector's internal notes or identity.
    return {
      status: out.status, finalValuation: out.finalValuation, customerDecision: out.customerDecision,
      physicalCondition: out.physicalCondition, screenCondition: out.screenCondition, batteryHealth: out.batteryHealth,
      imeiVerified: out.imeiVerified, remarks: out.status === 'PASSED' || out.status === 'FAILED' || out.status === 'RECHECK' ? out.remarks : undefined,
    }
  }
  return out
}

/** Create the QC row (inside a transaction) when a request is created or QC is first touched. */
export async function ensureQc(client, requestId, actor) {
  const { rows: ex } = await client.query(`SELECT * FROM sell_request_qc WHERE request_id = $1 FOR UPDATE`, [requestId])
  if (ex[0]) return ex[0]
  const { rows: m } = await client.query(`SELECT COUNT(*)::int AS n FROM sell_request_media WHERE entity_id = $1`, [requestId])
  const status = m[0].n > 0 ? 'EVIDENCE_UPLOADED' : 'AWAITING_EVIDENCE'
  const { rows } = await client.query(`INSERT INTO sell_request_qc (request_id, status) VALUES ($1,$2) RETURNING *`, [requestId, status])
  await history(client, requestId, null, status, 'QC_OPENED', actor)
  return rows[0]
}

async function history(client, requestId, from, to, action, actor, note = null, meta = {}) {
  await client.query(
    `INSERT INTO sell_request_qc_events (request_id, from_status, to_status, action, note, actor_id, actor_role, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [requestId, from, to, action, note, actor?.userId || null, actor?.kind || null, meta]
  )
}

function move(q, to) {
  if (!QC_TRANSITIONS[q.status]?.includes(to)) {
    throw new SellError('INVALID_QC_STATE', `QC cannot move from ${q.status} to ${to}`, 409, { from: q.status, to })
  }
}

async function loadLocked(client, actor, id) {
  const r = await lock(client, id, actor)
  if (CLOSED.includes(r.status)) throw new SellError('INVALID_STATE', 'This request is closed, so QC can no longer change', 409)
  const q = await ensureQc(client, id, actor)
  return { r, q }
}

async function mediaCount(client, id) {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM sell_request_media WHERE entity_id = $1`, [id])
  return rows[0].n
}

const done = (actor, id) => getQc(id).then((qc) => ({ requestId: id, qc }))

/** Staff picks the request up for inspection (optionally naming an inspector). */
export const startInspection = (actor, id, { inspectorId } = {}) => tx(async (client) => {
  const { q } = await loadLocked(client, actor, id)
  // A staff member might add the first evidence themselves; keep the stored status honest.
  if (q.status === 'AWAITING_EVIDENCE' && (await mediaCount(client, id)) > 0) q.status = 'EVIDENCE_UPLOADED'
  if (q.status === 'AWAITING_EVIDENCE') throw new SellError('NO_EVIDENCE', 'Upload at least one photo or video before inspection', 409)
  move(q, 'INSPECTION_PENDING')
  let inspector = actor.userId
  if (inspectorId) {
    const { rows } = await client.query(`SELECT id FROM users WHERE id = $1 AND is_active = TRUE AND role <> 'CUSTOMER'`, [inspectorId])
    if (!rows[0]) throw new SellError('VALIDATION', 'Inspector must be an active staff user', 422)
    inspector = inspectorId
  }
  await client.query(`UPDATE sell_request_qc SET status='INSPECTION_PENDING', inspector_id=$2, updated_at=NOW() WHERE request_id=$1`, [id, inspector])
  await history(client, id, q.status, 'INSPECTION_PENDING', 'INSPECTION_STARTED', actor, null, { inspectorId: inspector })
  await addEvent(client, id, 'QC_INSPECTION', 'Inspection started', actor)
}).then(() => done(actor, id))

/** Inspector records what they found. */
export const submitInspection = (actor, id, f = {}) => tx(async (client) => {
  const { r, q } = await loadLocked(client, actor, id)
  move(q, 'INSPECTION_COMPLETE')

  if (!PHYSICAL.includes(f.physicalCondition)) throw new SellError('VALIDATION', 'Physical condition is required', 422)
  if (!SCREEN.includes(f.screenCondition)) throw new SellError('VALIDATION', 'Screen condition is required', 422)
  if (typeof f.imeiVerified !== 'boolean') throw new SellError('VALIDATION', 'State whether the IMEI/serial was verified', 422)
  let battery = null
  if (f.batteryHealth != null && f.batteryHealth !== '') {
    battery = Number(f.batteryHealth)
    if (!Number.isInteger(battery) || battery < 0 || battery > 100) throw new SellError('VALIDATION', 'Battery health must be a whole number from 0 to 100', 422)
  }
  const func = {}
  for (const [k, v] of Object.entries(f.functionality || {})) {
    if (!FUNC_KEY.test(k) || typeof v !== 'boolean' || Object.keys(func).length >= 20) throw new SellError('VALIDATION', 'Functionality checks must be named true/false values', 422)
    func[k] = v
  }
  let observed = text(f.imeiObserved, 20) || null
  let verified = f.imeiVerified
  if (observed && observed !== r.imei) verified = false          // what the inspector saw wins over a ticked box
  if (verified && !observed) observed = r.imei
  if (!verified && !observed) throw new SellError('VALIDATION', 'Record the IMEI you saw when it could not be verified', 422)
  if ((await mediaCount(client, id)) === 0) throw new SellError('NO_EVIDENCE', 'Attach at least one photo or video as inspection evidence', 409)

  await client.query(
    `UPDATE sell_request_qc SET status='INSPECTION_COMPLETE', physical_condition=$2, screen_condition=$3, imei_verified=$4, imei_observed=$5,
            battery_health=$6, functionality=$7, remarks=$8, inspector_id=COALESCE(inspector_id,$9), inspected_at=NOW(), updated_at=NOW()
      WHERE request_id=$1`,
    [id, f.physicalCondition, f.screenCondition, verified, observed, battery, JSON.stringify(func), text(f.remarks, 2000) || null, actor.userId]
  )
  await history(client, id, q.status, 'INSPECTION_COMPLETE', 'INSPECTION_SUBMITTED', actor, text(f.remarks, 500) || null, { imeiVerified: verified })
  await addEvent(client, id, 'QC_INSPECTION', 'Inspection completed', actor)
}).then(() => done(actor, id))

/** Outcome of the inspection. PASSED fixes the final valuation the customer is asked to accept. */
export const decide = (actor, id, { result, note, finalValuation } = {}) => {
  if (!['PASSED', 'RECHECK', 'FAILED'].includes(result)) throw new SellError('VALIDATION', 'Result must be PASSED, RECHECK or FAILED', 422)
  return tx(async (client) => {
    const { r, q } = await loadLocked(client, actor, id)
    move(q, result)
    const n = text(note, 1000)
    if (result !== 'PASSED' && !n) throw new SellError('VALIDATION', 'A reason the customer or team can act on is required', 422)
    let valuation = null
    if (result === 'PASSED') {
      if (q.imei_verified === false) throw new SellError('IMEI_MISMATCH', 'A device whose IMEI could not be verified cannot pass QC', 409)
      valuation = finalValuation == null || finalValuation === '' ? Number(r.quote) : Number(finalValuation)
      if (!Number.isFinite(valuation) || valuation < 0 || valuation > 10_000_000) throw new SellError('VALIDATION', 'Final valuation is invalid', 422)
      valuation = Math.round(valuation * 100) / 100
    }
    await client.query(
      `UPDATE sell_request_qc SET status=$2, final_valuation=$3, remarks=COALESCE(NULLIF($4,''), remarks),
              customer_decision=$5, decided_by=$6, decided_at=NOW(), updated_at=NOW() WHERE request_id=$1`,
      [id, result, valuation, n, result === 'PASSED' ? 'PENDING' : 'NONE', actor.userId]
    )
    await history(client, id, q.status, result, `QC_${result}`, actor, n || null, valuation != null ? { finalValuation: valuation } : {})
    await addEvent(client, id, 'QC_RESULT', `QC ${result === 'PASSED' ? 'passed' : result === 'RECHECK' ? 'needs a recheck' : 'failed'}`, actor, { finalValuation: valuation })
    return { valuation, note: n }
  }).then(({ valuation, note: n }) => {
    notifySellEvent(`QC_${result}`, id, { finalValuation: valuation, message: n })
    return done(actor, id)
  })
}

/** Send a PASSED/FAILED case back for another inspection (needs a reason; not after the customer accepted). */
export const reopen = (actor, id, note) => tx(async (client) => {
  const { r, q } = await loadLocked(client, actor, id)
  move(q, 'RECHECK')
  const n = text(note, 1000)
  if (!n) throw new SellError('VALIDATION', 'A reason is required to reopen QC', 422)
  if (q.customer_decision === 'ACCEPTED' || ['APPROVED'].includes(r.status)) {
    throw new SellError('INVALID_STATE', 'The customer already accepted this valuation, so QC cannot be reopened', 409)
  }
  await client.query(`UPDATE sell_request_qc SET status='RECHECK', customer_decision='NONE', final_valuation=NULL, updated_at=NOW() WHERE request_id=$1`, [id])
  await history(client, id, q.status, 'RECHECK', 'QC_REOPENED', actor, n)
  await addEvent(client, id, 'QC_RESULT', 'QC reopened for recheck', actor, { reason: n })
}).then(() => done(actor, id))

/** RECHECK → inspection again (same call as starting, kept explicit for the UI). */
export const restartInspection = startInspection

/** Customer accepts or declines the final valuation. Declining closes the request. */
export async function customerDecision(userId, scopeKind, id, decision) {
  if (!['ACCEPT', 'DECLINE'].includes(decision)) throw new SellError('VALIDATION', 'Decision must be ACCEPT or DECLINE', 422)
  const actor = { kind: 'CUSTOMER', scopeKind, userId }
  await tx(async (client) => {
    const r = await lock(client, id, actor)
    if (r.user_id !== userId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
    if (CLOSED.includes(r.status)) throw new SellError('INVALID_STATE', 'This request is closed', 409)
    const { rows } = await client.query(`SELECT * FROM sell_request_qc WHERE request_id = $1 FOR UPDATE`, [id])
    const q = rows[0]
    if (!q || q.status !== 'PASSED' || q.customer_decision !== 'PENDING') {
      throw new SellError('INVALID_QC_STATE', 'There is no final valuation waiting for your decision', 409)
    }
    const to = decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED'
    await client.query(`UPDATE sell_request_qc SET customer_decision=$2, customer_decided_at=NOW(), updated_at=NOW() WHERE request_id=$1`, [id, to])
    await history(client, id, q.status, q.status, `CUSTOMER_${to}`, actor, null, { finalValuation: num(q.final_valuation) })
    await addEvent(client, id, 'QC_CUSTOMER_DECISION', decision === 'ACCEPT' ? 'Customer accepted the final valuation' : 'Customer declined the final valuation', actor)
  })
  if (decision === 'DECLINE') await cancel(actor, id, 'Customer declined the final valuation')
  return { requestId: id, qc: await getQc(id, { forCustomer: true }) }
}

// ── Gates used by approve / complete ────────────────────────────────────

/** Throws when an admin has made QC mandatory and the request has not cleared it. */
export async function assertQcAllowsApproval(client, requestId) {
  const { rows: s } = await client.query(`SELECT qc_required_for_approval FROM sell_settings WHERE id = TRUE`)
  if (!s[0]?.qc_required_for_approval) return
  const { rows } = await client.query(`SELECT status FROM sell_request_qc WHERE request_id = $1`, [requestId])
  if (rows[0]?.status !== 'PASSED') {
    throw new SellError('QC_NOT_PASSED', 'QC must pass before this request can be approved', 409, { qcStatus: rows[0]?.status || 'NOT_STARTED' })
  }
}

export async function assertQcAllowsCompletion(client, requestId) {
  const { rows: s } = await client.query(`SELECT qc_required_for_approval FROM sell_settings WHERE id = TRUE`)
  if (!s[0]?.qc_required_for_approval) return
  const { rows } = await client.query(`SELECT status, customer_decision FROM sell_request_qc WHERE request_id = $1`, [requestId])
  if (rows[0]?.status !== 'PASSED' || rows[0]?.customer_decision !== 'ACCEPTED') {
    throw new SellError('CUSTOMER_NOT_ACCEPTED', 'The customer must accept the final valuation before completion', 409)
  }
}
