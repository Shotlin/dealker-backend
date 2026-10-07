import { query, getClient } from '../../config/database.js'
import { orderOverview } from '../order-overview/order-overview.service.js'
import { supportService } from '../support/support.service.js'

/**
 * Refund "case file" — the staff-only investigation around a refund request.
 * Mounted by refund-case.routes.js under /api/v1/admin/refund-requests/:id/case.
 * Nothing in here is ever exposed to the customer or the seller.
 */

const httpError = (statusCode, message, code = 'REFUND_CASE_ERROR') => Object.assign(new Error(message), { statusCode, code })
const OPEN_REQUEST = ['PENDING', 'PROCESSING']
const DEFAULT_DAYS = 3

/** The steps a reviewer walks through. `available` tells the UI whether the data for that step already exists. */
export const CHECKS = [
  { key: 'spoke_customer', party: 'CUSTOMER', label: 'Spoke to the customer', help: 'Call or chat with the customer and hear their side of the story.' },
  { key: 'checked_customer_proof', party: 'CUSTOMER', label: 'Looked at the customer’s photos or video', help: 'Open each file in the Proof tab and mark what it shows.' },
  { key: 'spoke_seller', party: 'SELLER', label: 'Heard the seller’s side', help: 'Call the seller, ask what happened, and write down what they said.' },
  { key: 'checked_seller_proof', party: 'SELLER', label: 'Looked at the seller’s packing proof', help: 'Did the seller pack the right item in good condition?' },
  { key: 'checked_delivery', party: 'COURIER', label: 'Checked the delivery tracking', help: 'Was it delivered on time and to the right address?' },
  { key: 'checked_invoice', party: 'TEAM', label: 'Matched the invoice with the product', help: 'The item, price and quantity on the invoice should match the order.' },
  { key: 'wrote_findings', party: 'TEAM', label: 'Wrote down what we found', help: 'A short summary so anyone can understand the decision later.' },
]
const CHECK_KEYS = new Set(CHECKS.map((c) => c.key))

const REQUEST_SELECT = `
  SELECT r.*, o.order_number, o.total_payable AS order_total, o.wallet_amount AS order_wallet_amount, o.status AS order_status,
         u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
         io.name AS owner_name, io.email AS owner_email, ru.name AS resolved_by_name
    FROM refund_requests r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN users u ON u.id = r.customer_id
    LEFT JOIN users io ON io.id = r.investigation_owner
    LEFT JOIN users ru ON ru.id = r.resolved_by`

async function loadRequest(id, client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run(`${REQUEST_SELECT} WHERE r.id = $1${client ? ' FOR UPDATE OF r' : ''}`, [id])
  if (!rows[0]) throw httpError(404, 'Refund request not found', 'NOT_FOUND')
  return rows[0]
}

async function logEvent(client, requestId, { type, party = null, title, body = null, metadata = {}, actorId = null }) {
  const { rows } = await client.query(
    `INSERT INTO refund_case_events (refund_request_id, type, party, title, body, metadata, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [requestId, type, party, title, body, JSON.stringify(metadata), actorId])
  await client.query(`UPDATE refund_requests SET updated_at = NOW() WHERE id = $1`, [requestId])
  return rows[0].id
}

const assertOpen = (r) => {
  if (!OPEN_REQUEST.includes(r.status)) throw httpError(409, `This request is already ${r.status.toLowerCase()}, so the case is closed.`, 'CASE_CLOSED')
}

/** The first thing anyone does on a case quietly opens the investigation. */
async function ensureStarted(client, r, actorId) {
  if (r.investigation_status !== 'NOT_STARTED') return
  await client.query(
    `UPDATE refund_requests SET investigation_status = 'OPEN', investigation_owner = COALESCE(investigation_owner, $2),
            investigation_started_at = NOW(), investigation_due_at = COALESCE(investigation_due_at, NOW() + ($3 || ' days')::interval) WHERE id = $1`,
    [r.id, actorId, String(DEFAULT_DAYS)])
  await logEvent(client, r.id, { type: 'INVESTIGATION_STARTED', party: 'TEAM', title: 'Investigation opened', body: `Opened automatically. Deadline set to ${DEFAULT_DAYS} days.`, actorId })
}

async function withTx(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

const STATUS_LABEL = {
  NOT_STARTED: 'Not looked at yet', OPEN: 'We are investigating', WAITING_CUSTOMER: 'Waiting for the customer',
  WAITING_SELLER: 'Waiting for the seller', READY_TO_DECIDE: 'Ready for a decision', DECIDED: 'Decision made',
}

const iso = (d) => (d ? new Date(d).toISOString() : null)

const guessKind = (url = '', mime = '') => {
  const s = `${mime} ${url}`.toLowerCase()
  if (/video|\.(mp4|mov|webm|m4v)(\?|$)/.test(s)) return 'VIDEO'
  if (/audio|\.(mp3|m4a|wav|ogg|aac)(\?|$)/.test(s)) return 'AUDIO'
  if (/image|\.(png|jpe?g|webp|gif|heic)(\?|$)/.test(s)) return 'IMAGE'
  return 'DOCUMENT'
}

export const refundCaseService = {
  CHECKS,

  async get(id) {
    const r = await loadRequest(id)
    const overview = await orderOverview.get(r.order_id).catch(() => null)

    const evidenceRows = (await query(
      `SELECT e.*, up.name AS uploader_name, rv.name AS reviewer_name
         FROM refund_case_evidence e LEFT JOIN users up ON up.id = e.uploaded_by LEFT JOIN users rv ON rv.id = e.reviewed_by
        WHERE e.refund_request_id = $1 ORDER BY e.created_at`, [id])).rows
    const events = (await query(
      `SELECT ev.*, u.name AS actor_name FROM refund_case_events ev LEFT JOIN users u ON u.id = ev.actor_id
        WHERE ev.refund_request_id = $1 ORDER BY ev.created_at, ev.id`, [id])).rows

    // Every chat about this return (or this order). Staff see internal notes too.
    const ticketRows = (await query(
      `SELECT t.id, t.ticket_number, t.subject, t.status, t.created_at, t.refund_request_id, a.name AS assignee_name
         FROM support_tickets t LEFT JOIN users a ON a.id = t.assigned_to
        WHERE t.refund_request_id = $1 OR (t.order_id = $2 AND t.refund_request_id IS NULL)
        ORDER BY t.created_at`, [id, r.order_id])).rows
    const msgRows = ticketRows.length ? (await query(
      `SELECT m.id, m.ticket_id, m.sender_type, m.body, m.is_internal, m.attachments, m.created_at, u.name AS sender_name
         FROM support_messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.ticket_id = ANY($1) ORDER BY m.created_at, m.id`, [ticketRows.map((t) => t.id)])).rows : []
    const conversations = ticketRows.map((t) => ({
      id: t.id, number: t.ticket_number, subject: t.subject, status: t.status, started_at: t.created_at, assignee: t.assignee_name,
      linked_to_request: t.refund_request_id === id,
      messages: msgRows.filter((m) => m.ticket_id === t.id).map((m) => ({
        id: m.id, from: m.sender_type, name: m.sender_type === 'CUSTOMER' ? r.customer_name : m.sender_type === 'SYSTEM' ? 'Dealker' : m.sender_name,
        body: m.body, internal: m.is_internal, attachments: Array.isArray(m.attachments) ? m.attachments : [], at: m.created_at,
      })),
    }))

    // ── Proof: what staff added, plus what the system already holds ──────
    const evidence = evidenceRows.map((e) => ({
      id: e.id, origin: 'CASE', side: e.side, kind: e.kind, url: e.url, title: e.title, note: e.note,
      review: e.review, review_note: e.review_note, reviewed_by: e.reviewer_name, reviewed_at: e.reviewed_at,
      added_by: e.uploader_name, added_at: e.created_at, removable: true,
    }))
    for (const s of overview?.sellers ?? []) {
      for (const m of s.media) evidence.push({
        id: `pack-${m.id}`, origin: 'PACKING', side: 'SELLER', kind: m.kind, url: m.url, title: m.caption || `Packing proof from ${s.vendor.name ?? 'the seller'}`,
        note: 'Uploaded by the seller when packing the parcel.', review: 'UNREVIEWED', added_by: s.vendor.name, added_at: m.created_at, removable: false,
      })
      if (s.invoice?.url) evidence.push({
        id: `inv-${s.id}`, origin: 'INVOICE', side: 'SELLER', kind: 'INVOICE', url: s.invoice.url, title: `Seller invoice ${s.invoice.number}`,
        note: 'Invoice the seller issued for this parcel.', review: 'UNREVIEWED', added_by: s.vendor.name, added_at: null, removable: false,
      })
      if (s.shipment?.tracking_url) evidence.push({
        id: `trk-${s.id}`, origin: 'TRACKING', side: 'COURIER', kind: 'DOCUMENT', url: s.shipment.tracking_url, title: `Tracking page — ${s.shipment.courier ?? s.shipment.provider}${s.shipment.awb ? ` (${s.shipment.awb})` : ''}`,
        note: 'Live courier tracking page.', review: 'UNREVIEWED', added_by: s.shipment.courier ?? s.shipment.provider, added_at: null, removable: false,
      })
    }
    for (const c of conversations) for (const m of c.messages) for (const a of m.attachments) {
      const url = typeof a === 'string' ? a : a?.url
      if (!url) continue
      evidence.push({
        id: `chat-${m.id}-${url.slice(-12)}`, origin: 'CHAT', side: m.from === 'CUSTOMER' ? 'CUSTOMER' : 'TEAM', kind: guessKind(url, a?.type || a?.mime), url,
        title: a?.name || `File sent in chat by ${m.name ?? 'someone'}`, note: `Sent in chat ${c.number}.`, review: 'UNREVIEWED', added_by: m.name, added_at: m.at, removable: false,
      })
    }

    // ── What is in dispute ───────────────────────────────────────────────
    const flagged = new Set((Array.isArray(r.items) ? r.items : []).flatMap((i) => [i.orderItemId, i.productId].filter(Boolean)))
    const wholeOrder = r.scope === 'FULL_ORDER'
    const products = (overview?.sellers ?? []).flatMap((s) => s.items.map((i) => ({
      id: i.id, name: i.name, quantity: i.quantity, unit_price: i.unit_price, subtotal: i.subtotal, image: i.image, brand: i.brand, condition: i.condition,
      disputed: wholeOrder || flagged.has(i.id),
      seller: { id: s.vendor.id, name: s.vendor.name, phone: s.vendor.phone, parcel: s.number },
    })))
    if (!products.length && Array.isArray(r.items)) {
      for (const i of r.items) products.push({ id: i.orderItemId ?? i.productId, name: i.name, quantity: i.quantity, unit_price: null, subtotal: i.total, image: null, brand: null, condition: null, disputed: true, seller: null })
    }

    // ── Checklist ────────────────────────────────────────────────────────
    const calls = events.filter((e) => e.type === 'CALL')
    const agentChat = conversations.some((c) => c.messages.some((m) => m.from === 'AGENT' && !m.internal))
    const sellers = overview?.sellers ?? []
    const available = {
      spoke_customer: agentChat || calls.some((e) => e.party === 'CUSTOMER'),
      checked_customer_proof: evidence.some((e) => e.side === 'CUSTOMER'),
      spoke_seller: calls.some((e) => e.party === 'SELLER'),
      checked_seller_proof: evidence.some((e) => e.side === 'SELLER' && e.origin !== 'INVOICE'),
      checked_delivery: sellers.some((s) => s.shipment),
      checked_invoice: sellers.some((s) => s.invoice),
      wrote_findings: Boolean(r.investigation_findings && r.investigation_findings.trim()),
    }
    const state = r.verification || {}
    const nameById = new Map()
    const ids = Object.values(state).map((v) => v?.by).filter(Boolean)
    if (ids.length) for (const u of (await query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [ids])).rows) nameById.set(u.id, u.name)
    const checks = CHECKS.map((c) => ({
      ...c, done: Boolean(state[c.key]?.done), note: state[c.key]?.note ?? null, by: nameById.get(state[c.key]?.by) ?? null, at: state[c.key]?.at ?? null,
      available: available[c.key],
    }))

    // ── One timeline for everything ──────────────────────────────────────
    const timeline = []
    for (const t of overview?.timeline ?? []) timeline.push({ id: `o-${timeline.length}`, at: t.at, group: 'ORDER', party: t.kind === 'proof' ? 'SELLER' : t.kind === 'shipment' ? 'COURIER' : null, title: t.title, body: t.detail ?? null, actor: t.who ?? null, internal: false, type: t.kind })
    timeline.push({ id: 'req', at: r.created_at, group: 'CASE', party: 'CUSTOMER', title: r.source === 'ADMIN' ? 'Our team started this refund request' : 'Customer asked for a refund', body: r.reason, actor: r.source === 'ADMIN' ? null : r.customer_name, internal: false, type: 'REQUEST_CREATED' })
    for (const e of events) timeline.push({ id: e.id, at: e.created_at, group: 'CASE', party: e.party, title: e.title, body: e.body, actor: e.actor_name, internal: true, type: e.type, meta: e.metadata })
    for (const c of conversations) for (const m of c.messages) timeline.push({
      id: `m-${m.id}`, at: m.at, group: 'CHAT', party: m.from === 'CUSTOMER' ? 'CUSTOMER' : 'TEAM',
      title: m.internal ? `${m.name ?? 'Team member'} left a private note in chat` : m.from === 'CUSTOMER' ? `${m.name ?? 'The customer'} wrote in chat` : m.from === 'SYSTEM' ? 'Automatic chat message' : `${m.name ?? 'Team member'} replied in chat`,
      body: m.body, actor: m.name, internal: m.internal || m.from === 'SYSTEM', type: 'CHAT',
    })
    const decided = events.some((e) => e.type === 'APPROVED' || e.type === 'REJECTED')
    if (!decided && r.resolved_at && ['APPROVED', 'REJECTED'].includes(r.status)) {
      timeline.push({ id: 'res', at: r.resolved_at, group: 'CASE', party: 'TEAM', title: r.status === 'APPROVED' ? 'Refund approved' : 'Refund rejected', body: r.admin_notes, actor: r.resolved_by_name, internal: false, type: r.status })
    }
    timeline.sort((a, b) => new Date(a.at) - new Date(b.at))

    const due = r.investigation_due_at ? new Date(r.investigation_due_at) : null
    const msLeft = due ? due.getTime() - Date.now() : null
    const agents = await supportService.agents()
    const amount = r.resolved_amount != null ? Number(r.resolved_amount) : Number(r.computed_amount)

    return {
      request: {
        id: r.id, status: r.status === 'PROCESSING' ? 'PENDING' : r.status, scope: wholeOrder ? 'ALL' : 'SPECIFIC', reason: r.reason, source: r.source,
        amount, claimed_amount: Number(r.computed_amount), refund_to: r.status === 'APPROVED' ? (r.refund_destination === 'WALLET' ? 'wallet' : 'original') : null,
        preferred_destination: r.refund_destination === 'WALLET' ? 'wallet' : 'original',
        created_at: r.created_at, resolved_at: r.resolved_at, resolved_by: r.resolved_by_name, admin_note: r.admin_notes, last_error: r.last_error,
        order: { id: r.order_id, number: r.order_number, status: r.order_status, total: Number(r.order_total), wallet_used: Number(r.order_wallet_amount || 0) },
        customer: { id: r.customer_id, name: r.customer_name, phone: r.customer_phone, email: r.customer_email },
      },
      investigation: {
        status: r.investigation_status, started_at: r.investigation_started_at, due_at: iso(due), owner: r.investigation_owner ? { id: r.investigation_owner, name: r.owner_name, email: r.owner_email } : null,
        findings: r.investigation_findings ?? '', verdict: r.investigation_verdict,
        hours_left: msLeft == null ? null : Math.round(msLeft / 3600000), overdue: msLeft != null && msLeft < 0 && OPEN_REQUEST.includes(r.status),
      },
      overview, products, evidence, conversations, checks, timeline,
      sellers: sellers.map((s) => ({ id: s.vendor.id, name: s.vendor.name, legal_name: s.vendor.legal_name, phone: s.vendor.phone, email: s.vendor.email, rating: s.vendor.rating, parcel: s.number, city: s.pickup.city })),
      team: agents.map((a) => ({ id: a.id, name: a.name, email: a.email, open_tickets: a.open_tickets })),
    }
  },

  async start(id, { ownerId, dueInDays = DEFAULT_DAYS, note }, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      if (r.investigation_status !== 'NOT_STARTED') throw httpError(409, 'This investigation has already started.', 'ALREADY_STARTED')
      const owner = ownerId || actorId
      await client.query(
        `UPDATE refund_requests SET investigation_status = 'OPEN', investigation_owner = $2, investigation_started_at = NOW(),
                investigation_due_at = NOW() + ($3 || ' days')::interval WHERE id = $1`,
        [id, owner, String(dueInDays)])
      await logEvent(client, id, { type: 'INVESTIGATION_STARTED', party: 'TEAM', title: 'Investigation started', body: [`Deadline: ${dueInDays} day${dueInDays === 1 ? '' : 's'}.`, note].filter(Boolean).join(' '), actorId, metadata: { ownerId: owner, dueInDays } })
    })
  },

  async update(id, patch, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      await ensureStarted(client, r, actorId)
      const names = async (uid) => (uid ? (await client.query(`SELECT name FROM users WHERE id = $1`, [uid])).rows[0]?.name ?? 'someone' : 'nobody')

      if (patch.status && patch.status !== r.investigation_status) {
        await client.query(`UPDATE refund_requests SET investigation_status = $2 WHERE id = $1`, [id, patch.status])
        await logEvent(client, id, { type: 'STATUS_CHANGED', party: 'TEAM', title: 'Case status changed', body: `${STATUS_LABEL[r.investigation_status]} → ${STATUS_LABEL[patch.status]}`, actorId, metadata: { from: r.investigation_status, to: patch.status } })
      }
      if (patch.ownerId !== undefined && (patch.ownerId ?? null) !== (r.investigation_owner ?? null)) {
        if (patch.ownerId) {
          const ok = await client.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'ADMIN' AND is_active = true`, [patch.ownerId])
          if (!ok.rows[0]) throw httpError(400, 'The person in charge must be an active team member', 'VALIDATION_ERROR')
        }
        await client.query(`UPDATE refund_requests SET investigation_owner = $2 WHERE id = $1`, [id, patch.ownerId ?? null])
        await logEvent(client, id, { type: 'OWNER_CHANGED', party: 'TEAM', title: 'Person in charge changed', body: `${await names(r.investigation_owner)} → ${await names(patch.ownerId)}`, actorId, metadata: { from: r.investigation_owner, to: patch.ownerId ?? null } })
      }
      if (patch.dueAt !== undefined) {
        await client.query(`UPDATE refund_requests SET investigation_due_at = $2 WHERE id = $1`, [id, patch.dueAt])
        await logEvent(client, id, { type: 'DEADLINE_CHANGED', party: 'TEAM', title: 'Deadline changed', body: patch.dueAt ? `New deadline: ${new Date(patch.dueAt).toDateString()}` : 'Deadline removed', actorId, metadata: { from: iso(r.investigation_due_at), to: patch.dueAt } })
      }
      if (patch.findings !== undefined || patch.verdict !== undefined) {
        await client.query(
          `UPDATE refund_requests SET investigation_findings = COALESCE($2, investigation_findings), investigation_verdict = CASE WHEN $4 THEN $3 ELSE investigation_verdict END WHERE id = $1`,
          [id, patch.findings ?? null, patch.verdict ?? null, patch.verdict !== undefined])
        await logEvent(client, id, { type: 'FINDINGS_SAVED', party: 'TEAM', title: 'Findings saved', body: patch.findings ?? null, actorId, metadata: { verdict: patch.verdict ?? r.investigation_verdict } })
      }
    })
  },

  async addNote(id, { body, party = 'TEAM' }, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      await ensureStarted(client, r, actorId)
      await logEvent(client, id, { type: 'NOTE', party, title: party === 'TEAM' ? 'Private note' : `Note about the ${party.toLowerCase()}`, body: body.trim(), actorId })
    })
  },

  async logCall(id, { party, direction = 'OUTGOING', outcome = 'SPOKE', person, summary, minutes, recordingUrl }, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      await ensureStarted(client, r, actorId)
      const who = party === 'CUSTOMER' ? 'the customer' : party === 'SELLER' ? 'the seller' : 'the courier'
      const verb = outcome === 'NO_ANSWER' ? 'Tried to reach' : direction === 'INCOMING' ? 'Received a call from' : 'Called'
      await logEvent(client, id, { type: 'CALL', party, title: `${verb} ${who}${person ? ` (${person})` : ''}`, body: summary.trim(), actorId, metadata: { direction, outcome, minutes: minutes ?? null, recordingUrl: recordingUrl ?? null, person: person ?? null } })
      if (recordingUrl) {
        await client.query(
          `INSERT INTO refund_case_evidence (refund_request_id, side, kind, url, title, note, uploaded_by) VALUES ($1,$2,'AUDIO',$3,$4,$5,$6)`,
          [id, party, recordingUrl, `Call recording — ${who}`, summary.trim().slice(0, 240), actorId])
      }
    })
  },

  async addEvidence(id, { side, kind, url, title, note }, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      await ensureStarted(client, r, actorId)
      const { rows } = await client.query(
        `INSERT INTO refund_case_evidence (refund_request_id, side, kind, url, title, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, side, kind, url, title.trim(), note?.trim() || null, actorId])
      const from = { CUSTOMER: 'the customer', SELLER: 'the seller', COURIER: 'the courier', TEAM: 'our team' }[side]
      await logEvent(client, id, { type: 'EVIDENCE_ADDED', party: side, title: `Added proof from ${from}`, body: title.trim(), actorId, metadata: { evidenceId: rows[0].id, kind } })
      return { id: rows[0].id }
    })
  },

  async reviewEvidence(id, evidenceId, { review, note }, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      const { rows } = await client.query(
        `UPDATE refund_case_evidence SET review = $3, review_note = $4, reviewed_by = $5, reviewed_at = NOW() WHERE id = $1 AND refund_request_id = $2 RETURNING title, side`,
        [evidenceId, id, review, note?.trim() || null, actorId])
      if (!rows[0]) throw httpError(404, 'Proof not found', 'NOT_FOUND')
      const label = { SUPPORTS_CUSTOMER: 'helps the customer', SUPPORTS_SELLER: 'helps the seller', NOT_USEFUL: 'is not useful', UNREVIEWED: 'is back to “not checked yet”' }[review]
      await logEvent(client, id, { type: 'EVIDENCE_REVIEWED', party: 'TEAM', title: `Marked “${rows[0].title}” — ${label}`, body: note?.trim() || null, actorId, metadata: { evidenceId, review } })
    })
  },

  async removeEvidence(id, evidenceId, actorId) {
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      const { rows } = await client.query(`DELETE FROM refund_case_evidence WHERE id = $1 AND refund_request_id = $2 RETURNING title`, [evidenceId, id])
      if (!rows[0]) throw httpError(404, 'Proof not found', 'NOT_FOUND')
      await logEvent(client, id, { type: 'EVIDENCE_REMOVED', party: 'TEAM', title: 'Removed a piece of proof', body: rows[0].title, actorId })
    })
  },

  async setCheck(id, key, { done, note }, actorId) {
    if (!CHECK_KEYS.has(key)) throw httpError(400, 'Unknown check', 'VALIDATION_ERROR')
    return withTx(async (client) => {
      const r = await loadRequest(id, client)
      assertOpen(r)
      await ensureStarted(client, r, actorId)
      const next = { ...(r.verification || {}) }
      next[key] = done ? { done: true, by: actorId, at: new Date().toISOString(), note: note?.trim() || null } : { done: false }
      await client.query(`UPDATE refund_requests SET verification = $2 WHERE id = $1`, [id, JSON.stringify(next)])
      const check = CHECKS.find((c) => c.key === key)
      await logEvent(client, id, { type: done ? 'CHECK_DONE' : 'CHECK_UNDONE', party: check.party, title: `${done ? 'Ticked' : 'Un-ticked'}: ${check.label}`, body: done ? note?.trim() || null : null, actorId })
    })
  },

  /** Called inside approve/reject transactions so the case file always records the decision. */
  async recordDecision(client, id, { approved, amount, destination, note, actorId }) {
    await client.query(`UPDATE refund_requests SET investigation_status = 'DECIDED' WHERE id = $1`, [id])
    await logEvent(client, id, approved
      ? { type: 'APPROVED', party: 'TEAM', title: 'Refund approved', body: `₹${Number(amount).toLocaleString('en-IN')} sent to ${destination === 'WALLET' ? 'the customer’s wallet' : 'the original payment method'}.${note ? ` ${note}` : ''}`, actorId, metadata: { amount, destination } }
      : { type: 'REJECTED', party: 'TEAM', title: 'Refund rejected', body: note || null, actorId })
  },
}
