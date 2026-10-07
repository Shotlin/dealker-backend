import { query, getClient } from '../../config/database.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED']

const httpError = (statusCode, message, code = 'SUPPORT_ERROR') => Object.assign(new Error(message), { statusCode, code })

function emit(event, payload, { customerId, assigneeId } = {}) {
  try {
    const io = getSocketEmitter()
    io.to('hq:global').emit(event, payload)
    io.to('admin:dashboard').emit(event, payload)
    if (assigneeId) io.to(`user:${assigneeId}`).emit(event, payload)
    if (customerId) io.to(`user:${customerId}`).emit(event, payload)
  } catch { /* realtime is best-effort */ }
}

const TICKET_SELECT = `
  SELECT t.*,
         c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
         a.name AS assignee_name, a.email AS assignee_email,
         o.order_number, o.status AS order_status, o.total_payable AS order_total,
         rr.status AS refund_status, rr.computed_amount AS refund_amount
    FROM support_tickets t
    JOIN users c ON c.id = t.user_id
    LEFT JOIN users a ON a.id = t.assigned_to
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN refund_requests rr ON rr.id = t.refund_request_id`

const toTicket = (r) => ({
  id: r.id,
  ticket_number: r.ticket_number,
  subject: r.subject,
  status: r.status,
  priority: r.priority,
  category: r.category,
  channel: r.channel,
  customer: { id: r.user_id, name: r.customer_name, phone: r.customer_phone, email: r.customer_email },
  assignee: r.assigned_to ? { id: r.assigned_to, name: r.assignee_name, email: r.assignee_email } : null,
  order: r.order_id ? { id: r.order_id, order_number: r.order_number, status: r.order_status, total: Number(r.order_total) } : null,
  refund: r.refund_request_id ? { id: r.refund_request_id, status: r.refund_status, amount: Number(r.refund_amount) } : null,
  last_message_at: r.last_message_at,
  last_message_preview: r.last_message_preview,
  last_sender_type: r.last_sender_type,
  agent_unread: r.agent_unread,
  customer_unread: r.customer_unread,
  first_response_at: r.first_response_at,
  resolved_at: r.resolved_at,
  created_at: r.created_at,
  updated_at: r.updated_at,
})

const preview = (s) => String(s).replace(/\s+/g, ' ').slice(0, 140)

async function addEvent(client, ticketId, type, actorId, from, to) {
  await client.query(
    `INSERT INTO support_ticket_events (ticket_id, type, actor_id, from_value, to_value) VALUES ($1,$2,$3,$4,$5)`,
    [ticketId, type, actorId ?? null, from ?? null, to ?? null])
}

export const supportService = {
  OPEN_STATUSES,

  // ── Admin: inbox ─────────────────────────────────────────────────────
  async list(agentId, q = {}) {
    const { view = 'all', status, priority, category, search, assignee, page = 1, limit = 30 } = q
    const where = []
    const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (view === 'mine') where.push(`t.assigned_to = ${p(agentId)}`)
    else if (view === 'unassigned') where.push(`t.assigned_to IS NULL AND t.status = ANY(${p(OPEN_STATUSES)})`)
    else if (view === 'open') where.push(`t.status = ANY(${p(OPEN_STATUSES)})`)
    else if (view === 'resolved') where.push(`t.status IN ('RESOLVED','CLOSED')`)
    if (status) where.push(`t.status = ${p(status)}`)
    if (priority) where.push(`t.priority = ${p(priority)}`)
    if (category) where.push(`t.category = ${p(category)}`)
    if (assignee) where.push(`t.assigned_to = ${p(assignee)}`)
    if (search) {
      const s = p(`%${search}%`)
      where.push(`(t.ticket_number ILIKE ${s} OR t.subject ILIKE ${s} OR c.name ILIKE ${s} OR c.phone ILIKE ${s} OR o.order_number ILIKE ${s})`)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Number(limit) || 30)
    const off = (Math.max(1, Number(page)) - 1) * lim
    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int n FROM support_tickets t JOIN users c ON c.id = t.user_id LEFT JOIN orders o ON o.id = t.order_id ${w}`, params)
    const { rows } = await query(
      `${TICKET_SELECT} ${w}
       ORDER BY (t.agent_unread > 0) DESC, COALESCE(t.last_message_at, t.created_at) DESC
       LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows.map(toTicket), pagination: { page: Number(page), limit: lim, total: cnt[0].n } }
  },

  async stats(agentId) {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = ANY($2))::int AS open,
         COUNT(*) FILTER (WHERE assigned_to IS NULL AND status = ANY($2))::int AS unassigned,
         COUNT(*) FILTER (WHERE assigned_to = $1 AND status = ANY($2))::int AS mine,
         COUNT(*) FILTER (WHERE priority = 'URGENT' AND status = ANY($2))::int AS urgent,
         COUNT(*) FILTER (WHERE resolved_at >= date_trunc('day', NOW()))::int AS resolved_today,
         COALESCE(SUM(agent_unread) FILTER (WHERE status = ANY($2)), 0)::int AS unread,
         COALESCE(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))) FILTER (WHERE first_response_at IS NOT NULL AND created_at >= NOW() - interval '30 days'), 0)::int AS avg_first_response_seconds
       FROM support_tickets`, [agentId, OPEN_STATUSES])
    return rows[0]
  },

  async agents() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.platform_role, r.name AS role_name,
              (SELECT COUNT(*)::int FROM support_tickets t WHERE t.assigned_to = u.id AND t.status = ANY($1)) AS open_tickets
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.role = 'ADMIN' AND u.is_active = true AND COALESCE(u.is_blocked,false) = false
        ORDER BY u.name NULLS LAST`, [OPEN_STATUSES])
    return rows
  },

  async canned() {
    const { rows } = await query(`SELECT id, title, body, category FROM support_canned_replies ORDER BY sort_order, title`)
    return rows
  },

  // ── Detail ───────────────────────────────────────────────────────────
  async detail(id, { forCustomerId = null } = {}) {
    const { rows } = await query(`${TICKET_SELECT} WHERE t.id = $1 ${forCustomerId ? 'AND t.user_id = $2' : ''}`, forCustomerId ? [id, forCustomerId] : [id])
    if (!rows[0]) throw httpError(404, 'Conversation not found', 'NOT_FOUND')
    const t = toTicket(rows[0])
    const { rows: msgs } = await query(
      `SELECT m.id, m.sender_type, m.sender_id, m.body, m.is_internal, m.attachments, m.created_at, u.name AS sender_name
         FROM support_messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.ticket_id = $1 ${forCustomerId ? 'AND m.is_internal = false' : ''}
        ORDER BY m.created_at, m.id`, [id])
    let events = []
    let context = null
    if (!forCustomerId) {
      const ev = await query(
        `SELECT e.id, e.type, e.from_value, e.to_value, e.created_at, u.name AS actor_name,
                (SELECT name FROM users WHERE id::text = e.to_value) AS to_name,
                (SELECT name FROM users WHERE id::text = e.from_value) AS from_name
           FROM support_ticket_events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.ticket_id = $1 ORDER BY e.created_at`, [id])
      events = ev.rows
      const cs = await query(
        `SELECT COUNT(*)::int AS orders_count, COALESCE(SUM(total_payable) FILTER (WHERE payment_status = 'PAID'),0)::numeric AS total_spent,
                (SELECT COUNT(*)::int FROM support_tickets WHERE user_id = $1) AS tickets_count,
                (SELECT created_at FROM users WHERE id = $1) AS joined_at
           FROM orders WHERE customer_id = $1`, [t.customer.id])
      context = { ...cs.rows[0], total_spent: Number(cs.rows[0].total_spent) }
      if (t.order) {
        const items = await query(`SELECT product_name, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY created_at LIMIT 10`, [t.order.id])
        const sellers = await query(
          `SELECT v.name FROM seller_orders so JOIN vendors v ON v.id = so.vendor_id WHERE so.order_id = $1`, [t.order.id])
        t.order.items = items.rows.map((i) => ({ name: i.product_name, quantity: Number(i.quantity), price: Number(i.unit_price) }))
        t.order.sellers = sellers.rows.map((s) => s.name)
      }
      const others = await query(
        `SELECT id, ticket_number, subject, status, created_at FROM support_tickets WHERE user_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 5`, [t.customer.id, id])
      context.other_tickets = others.rows
    }
    return { ticket: t, messages: msgs, events, context }
  },

  async markRead(id, side) {
    const col = side === 'customer' ? 'customer_unread' : 'agent_unread'
    await query(`UPDATE support_tickets SET ${col} = 0 WHERE id = $1`, [id])
  },

  // ── Create ───────────────────────────────────────────────────────────
  async create({ userId, subject, message, category = 'GENERAL', priority = 'NORMAL', orderId = null, refundRequestId = null, channel = 'APP', senderType = 'CUSTOMER', actorId = null, assignTo = null }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (orderId) {
        const o = await client.query(`SELECT 1 FROM orders WHERE id = $1 ${senderType === 'CUSTOMER' ? 'AND customer_id = $2' : ''}`, senderType === 'CUSTOMER' ? [orderId, userId] : [orderId])
        if (!o.rows[0]) throw httpError(404, 'Order not found', 'NOT_FOUND')
      }
      const { rows: seq } = await client.query(`SELECT nextval('support_ticket_seq') AS n`)
      const number = `TKT-${seq[0].n}`
      const agentSide = senderType !== 'CUSTOMER'
      const { rows } = await client.query(
        `INSERT INTO support_tickets (ticket_number, user_id, subject, description, status, category, priority, order_id, refund_request_id, channel,
            last_message_at, last_message_preview, last_sender_type, agent_unread, customer_unread, assigned_to, assigned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), $11, $12, $13, $14, $15, CASE WHEN $15::uuid IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
        [number, userId, subject, message, assignTo ? 'ASSIGNED' : 'OPEN', category, priority, orderId, refundRequestId, channel,
          preview(message), senderType, agentSide ? 0 : 1, agentSide ? 1 : 0, assignTo])
      const id = rows[0].id
      await client.query(
        `INSERT INTO support_messages (ticket_id, sender_type, sender_id, body) VALUES ($1,$2,$3,$4)`,
        [id, senderType, senderType === 'CUSTOMER' ? userId : actorId, message])
      await addEvent(client, id, 'CREATED', actorId ?? userId, null, null)
      if (assignTo) await addEvent(client, id, 'ASSIGNED', actorId, null, assignTo)
      await client.query('COMMIT')
      emit('support:ticket', { ticketId: id, kind: 'created' }, { customerId: userId, assigneeId: assignTo })
      return this.detail(id)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  },

  /** Admin "start chat" from an order / refund request — reuses an open conversation if one exists. */
  async startFromContext({ orderId, refundRequestId, actorId }) {
    let userId; let subject; let category = 'ORDER'; let message; let oid = orderId || null
    if (refundRequestId) {
      const ex = await query(`SELECT id FROM support_tickets WHERE refund_request_id = $1 AND status = ANY($2) LIMIT 1`, [refundRequestId, OPEN_STATUSES])
      if (ex.rows[0]) return this.detail(ex.rows[0].id)
      const { rows } = await query(
        `SELECT r.customer_id, r.order_id, r.reason, o.order_number FROM refund_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = $1`, [refundRequestId])
      if (!rows[0]) throw httpError(404, 'Refund request not found', 'NOT_FOUND')
      userId = rows[0].customer_id; oid = rows[0].order_id; category = 'RETURN_REFUND'
      subject = `Return / refund for order ${rows[0].order_number}`
      message = `Opened by support regarding your return request for order ${rows[0].order_number} (“${rows[0].reason}”).`
    } else if (orderId) {
      const ex = await query(`SELECT id FROM support_tickets WHERE order_id = $1 AND refund_request_id IS NULL AND status = ANY($2) LIMIT 1`, [orderId, OPEN_STATUSES])
      if (ex.rows[0]) return this.detail(ex.rows[0].id)
      const { rows } = await query(`SELECT customer_id, order_number FROM orders WHERE id = $1`, [orderId])
      if (!rows[0]) throw httpError(404, 'Order not found', 'NOT_FOUND')
      userId = rows[0].customer_id
      subject = `Order ${rows[0].order_number}`
      message = `Support opened a conversation about your order ${rows[0].order_number}.`
    } else throw httpError(400, 'orderId or refundRequestId required', 'VALIDATION_ERROR')
    return this.create({ userId, subject, message, category, orderId: oid, refundRequestId: refundRequestId || null, channel: 'ADMIN', senderType: 'SYSTEM', actorId, assignTo: actorId })
  },

  // ── Messages ─────────────────────────────────────────────────────────
  async addMessage(id, { body, internal = false, sender }) {
    const text = String(body || '').trim()
    if (!text) throw httpError(400, 'Message is empty', 'VALIDATION_ERROR')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE`, [id])
      const t = rows[0]
      if (!t) throw httpError(404, 'Conversation not found', 'NOT_FOUND')
      const isCustomer = sender.type === 'CUSTOMER'
      if (isCustomer && t.user_id !== sender.id) throw httpError(404, 'Conversation not found', 'NOT_FOUND')
      if (isCustomer && t.status === 'CLOSED') throw httpError(409, 'This conversation is closed. Please start a new one.', 'CLOSED')
      const isInternal = !isCustomer && Boolean(internal)
      const { rows: m } = await client.query(
        `INSERT INTO support_messages (ticket_id, sender_type, sender_id, body, is_internal) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [id, sender.type, sender.id, text, isInternal])

      let status = t.status
      let assignedTo = t.assigned_to
      if (isCustomer) {
        if (['RESOLVED', 'CLOSED'].includes(t.status)) { status = 'REOPENED'; await addEvent(client, id, 'STATUS', sender.id, t.status, status) }
        await client.query(
          `UPDATE support_tickets SET status=$2, last_message_at=NOW(), last_message_preview=$3, last_sender_type='CUSTOMER', agent_unread=agent_unread+1, resolved_at=NULL, updated_at=NOW() WHERE id=$1`,
          [id, status, preview(text)])
      } else if (isInternal) {
        await client.query(`UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`, [id])
      } else {
        if (!assignedTo) { assignedTo = sender.id; await addEvent(client, id, 'ASSIGNED', sender.id, null, sender.id) }
        if (['OPEN', 'ASSIGNED', 'REOPENED'].includes(t.status)) { status = 'IN_PROGRESS'; await addEvent(client, id, 'STATUS', sender.id, t.status, status) }
        await client.query(
          `UPDATE support_tickets SET status=$2, assigned_to=$3, assigned_at=COALESCE(assigned_at, NOW()), last_message_at=NOW(), last_message_preview=$4, last_sender_type='AGENT',
                  customer_unread=customer_unread+1, agent_unread=0, first_response_at=COALESCE(first_response_at, NOW()), updated_at=NOW() WHERE id=$1`,
          [id, status, assignedTo, preview(text)])
        await client.query(
          `INSERT INTO notifications (user_id, title, body, type, data) VALUES ($1,'Dealker Support replied',$2,'SUPPORT',$3)`,
          [t.user_id, preview(text), JSON.stringify({ ticketId: id, ticketNumber: t.ticket_number })])
      }
      await client.query('COMMIT')
      emit('support:message', { ticketId: id, internal: isInternal, from: sender.type }, { customerId: isInternal ? null : t.user_id, assigneeId: assignedTo })
      return { id: m[0].id, created_at: m[0].created_at, status }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  },

  // ── Admin updates ────────────────────────────────────────────────────
  async update(id, patch, actorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE`, [id])
      const t = rows[0]
      if (!t) throw httpError(404, 'Conversation not found', 'NOT_FOUND')
      const sets = []; const vals = [id]
      const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
      if (patch.status && patch.status !== t.status) {
        set('status', patch.status)
        if (['RESOLVED', 'CLOSED'].includes(patch.status)) sets.push('resolved_at = COALESCE(resolved_at, NOW())')
        else sets.push('resolved_at = NULL')
        await addEvent(client, id, 'STATUS', actorId, t.status, patch.status)
        if (patch.status === 'RESOLVED') {
          await client.query(`INSERT INTO support_messages (ticket_id, sender_type, body) VALUES ($1,'SYSTEM','This conversation was marked as resolved. Reply here if you need more help.')`, [id])
        }
      }
      if (patch.priority && patch.priority !== t.priority) { set('priority', patch.priority); await addEvent(client, id, 'PRIORITY', actorId, t.priority, patch.priority) }
      if (patch.category && patch.category !== t.category) { set('category', patch.category); await addEvent(client, id, 'CATEGORY', actorId, t.category, patch.category) }
      if (sets.length) await client.query(`UPDATE support_tickets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals)
      await client.query('COMMIT')
      emit('support:ticket', { ticketId: id, kind: 'updated' }, { customerId: t.user_id, assigneeId: t.assigned_to })
      return this.detail(id)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  },

  async assign(id, assigneeId, actorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE`, [id])
      const t = rows[0]
      if (!t) throw httpError(404, 'Conversation not found', 'NOT_FOUND')
      if (assigneeId) {
        const a = await client.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'ADMIN' AND is_active = true`, [assigneeId])
        if (!a.rows[0]) throw httpError(400, 'Assignee must be an active team member', 'VALIDATION_ERROR')
      }
      if ((t.assigned_to ?? null) !== (assigneeId ?? null)) {
        const newStatus = assigneeId ? (t.status === 'OPEN' || t.status === 'REOPENED' ? 'ASSIGNED' : t.status) : (t.status === 'ASSIGNED' ? 'OPEN' : t.status)
        await client.query(`UPDATE support_tickets SET assigned_to=$2, assigned_at=NOW(), status=$3, updated_at=NOW() WHERE id=$1`, [id, assigneeId ?? null, newStatus])
        await addEvent(client, id, 'ASSIGNED', actorId, t.assigned_to, assigneeId ?? null)
        if (newStatus !== t.status) await addEvent(client, id, 'STATUS', actorId, t.status, newStatus)
      }
      await client.query('COMMIT')
      emit('support:ticket', { ticketId: id, kind: 'assigned' }, { assigneeId, customerId: null })
      return this.detail(id)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  },

  // ── Customer ─────────────────────────────────────────────────────────
  async listMine(userId) {
    const { rows } = await query(`${TICKET_SELECT} WHERE t.user_id = $1 ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 50`, [userId])
    return rows.map((r) => {
      const t = toTicket(r)
      delete t.assignee; delete t.agent_unread
      return t
    })
  },
}
