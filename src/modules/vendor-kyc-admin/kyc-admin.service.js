import { query, getClient } from '../../config/database.js'

const err = (statusCode, message, code = 'KYC_ERROR') => Object.assign(new Error(message), { statusCode, code })

// action → { from: allowed current statuses, to: new status, needsNote }
const FLOW = {
  START_REVIEW:       { from: ['KYC_SUBMITTED', 'CORRECTION_REQUIRED'], to: 'UNDER_REVIEW' },
  APPROVE:            { from: ['KYC_SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED'], to: 'VERIFIED' },
  ACTIVATE:           { from: ['VERIFIED'], to: 'ACTIVE' },
  REQUEST_CORRECTION: { from: ['KYC_SUBMITTED', 'UNDER_REVIEW'], to: 'CORRECTION_REQUIRED', needsNote: true },
  REJECT:             { from: ['KYC_SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED'], to: 'REJECTED', needsNote: true },
  SUSPEND:            { from: ['VERIFIED', 'ACTIVE'], to: 'SUSPENDED', needsNote: true },
  REINSTATE:          { from: ['SUSPENDED', 'REJECTED'], to: 'ACTIVE' },
}
const NOTIFY = {
  START_REVIEW: ['KYC review started', 'Our team has started reviewing your documents.'],
  APPROVE: ['KYC approved', 'Your business has been verified.'],
  ACTIVATE: ['Your store is live', 'You can now list products and sell on Dealker.'],
  REQUEST_CORRECTION: ['Action needed on your KYC', 'Please fix the issues noted and resubmit.'],
  REJECT: ['KYC rejected', 'Your application could not be approved.'],
  SUSPEND: ['Your account is suspended', 'Please contact Dealker support.'],
  REINSTATE: ['Your account is active again', 'You can continue selling.'],
}

export const kycAdmin = {
  async summary() {
    const { rows } = await query(`SELECT status, COUNT(*)::int n FROM vendors WHERE deleted_at IS NULL GROUP BY status`)
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]))
    const total = rows.reduce((s, r) => s + r.n, 0)
    return { total, byStatus: by, needsReview: (by.KYC_SUBMITTED || 0) + (by.UNDER_REVIEW || 0) }
  },

  async list({ status, group, search, page = 1, limit = 20 } = {}) {
    const where = ['v.deleted_at IS NULL']; const params = []
    const p = (x) => { params.push(x); return `$${params.length}` }
    if (group === 'review') where.push(`v.status IN ('KYC_SUBMITTED','UNDER_REVIEW')`)
    else if (group === 'blocked') where.push(`v.status IN ('SUSPENDED','REJECTED','DEACTIVATED')`)
    else if (status) where.push(`v.status = ${p(status)}`)
    if (search) { const s = p(`%${search}%`); where.push(`(v.name ILIKE ${s} OR v.email ILIKE ${s} OR v.phone ILIKE ${s} OR vp.gstin ILIKE ${s} OR vp.city ILIKE ${s})`) }
    const w = `WHERE ${where.join(' AND ')}`
    const lim = Math.min(100, Number(limit) || 20); const off = (Math.max(1, Number(page)) - 1) * lim
    const base = `FROM vendors v LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id ${w}`
    const cnt = await query(`SELECT COUNT(*)::int n ${base}`, params)
    const { rows } = await query(
      `SELECT v.id, v.name, v.email, v.phone, v.status, v.is_active, v.created_at, vp.legal_name, vp.gstin, vp.city, vp.state,
              (SELECT COUNT(*)::int FROM vendor_documents d WHERE d.vendor_id = v.id) AS docs_total,
              (SELECT COUNT(*) FILTER (WHERE d.status = 'VERIFIED')::int FROM vendor_documents d WHERE d.vendor_id = v.id) AS docs_verified,
              (SELECT COUNT(*) FILTER (WHERE d.status = 'REJECTED')::int FROM vendor_documents d WHERE d.vendor_id = v.id) AS docs_rejected,
              (SELECT COUNT(*)::int FROM shop_products sp JOIN shops s ON s.id = sp.shop_id WHERE s.vendor_id = v.id AND sp.deleted_at IS NULL) AS listings,
              (SELECT MAX(r.created_at) FROM vendor_kyc_reviews r WHERE r.vendor_id = v.id AND r.action = 'SUBMIT') AS submitted_at
         ${base} ORDER BY (v.status IN ('KYC_SUBMITTED','UNDER_REVIEW')) DESC, v.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows, pagination: { page: Number(page), limit: lim, total: cnt.rows[0].n } }
  },

  async detail(vendorId) {
    const v = (await query(`SELECT * FROM vendors WHERE id = $1 AND deleted_at IS NULL`, [vendorId])).rows[0]
    if (!v) throw err(404, 'Vendor not found', 'NOT_FOUND')
    const profile = (await query(`SELECT * FROM vendor_profiles WHERE vendor_id = $1`, [vendorId])).rows[0] ?? null
    const documents = (await query(`SELECT d.*, u.name AS reviewed_by_name FROM vendor_documents d LEFT JOIN users u ON u.id = d.reviewed_by WHERE d.vendor_id = $1 ORDER BY d.created_at`, [vendorId])).rows
    const history = (await query(`SELECT r.*, u.name AS reviewer_name FROM vendor_kyc_reviews r LEFT JOIN users u ON u.id = r.reviewer_id WHERE r.vendor_id = $1 ORDER BY r.created_at DESC`, [vendorId])).rows
    const shops = (await query(`SELECT id, name, city, state, pincode, is_active, commission_rate, seller_rating, total_orders FROM shops WHERE vendor_id = $1 AND deleted_at IS NULL`, [vendorId])).rows
    const stats = (await query(
      `SELECT (SELECT COUNT(*)::int FROM shop_products sp JOIN shops s ON s.id = sp.shop_id WHERE s.vendor_id = $1 AND sp.deleted_at IS NULL) AS listings,
              (SELECT COUNT(*)::int FROM seller_orders WHERE vendor_id = $1 AND status <> 'CANCELLED') AS orders,
              (SELECT COALESCE(SUM(item_subtotal),0) FROM seller_orders WHERE vendor_id = $1 AND status = 'DELIVERED') AS gmv,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE seller_vendor_id = $1 OR buyer_vendor_id = $1) AS b2b_orders`, [vendorId])).rows[0]
    const team = (await query(`SELECT u.name, u.phone, vu.role FROM vendor_users vu JOIN users u ON u.id = vu.user_id WHERE vu.vendor_id = $1 AND vu.is_active = true`, [vendorId])).rows
    const allowed = Object.entries(FLOW).filter(([, f]) => f.from.includes(v.status)).map(([a, f]) => ({ action: a, needsNote: Boolean(f.needsNote) }))
    return { vendor: v, profile, documents, history, shops, team, stats: { ...stats, gmv: Number(stats.gmv) }, allowedActions: allowed }
  },

  async review(vendorId, { action, comments, override }, actorId) {
    const f = FLOW[action]
    if (!f) throw err(400, 'Unknown action', 'VALIDATION_ERROR')
    if (f.needsNote && !String(comments || '').trim()) throw err(400, 'A note is required for this action — the vendor will see it', 'VALIDATION_ERROR')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const v = (await client.query(`SELECT * FROM vendors WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [vendorId])).rows[0]
      if (!v) throw err(404, 'Vendor not found', 'NOT_FOUND')
      if (!f.from.includes(v.status)) throw err(409, `Cannot ${action.replace('_', ' ').toLowerCase()} a vendor that is ${v.status.replace(/_/g, ' ').toLowerCase()}`, 'INVALID_TRANSITION')
      if (action === 'APPROVE' && !override) {
        const d = (await client.query(`SELECT status, document_type FROM vendor_documents WHERE vendor_id = $1`, [vendorId])).rows
        if (!d.length) throw err(409, 'The vendor has not uploaded any documents. Approve anyway only with an override note.', 'DOCS_MISSING')
        const bad = d.filter((x) => x.status !== 'VERIFIED')
        if (bad.length) throw err(409, `${bad.length} document(s) are not verified yet — verify them first, or approve with an override note.`, 'DOCS_UNVERIFIED')
      }
      if (override && !String(comments || '').trim()) throw err(400, 'Add a note explaining the override', 'VALIDATION_ERROR')
      const active = ['ACTIVE', 'VERIFIED'].includes(f.to) ? f.to === 'ACTIVE' || v.is_active : false
      await client.query(`UPDATE vendors SET status = $2, is_active = $3, updated_at = NOW() WHERE id = $1`, [vendorId, f.to, f.to === 'ACTIVE'])
      await client.query(
        `INSERT INTO vendor_kyc_reviews (vendor_id, reviewer_id, action, previous_status, new_status, comments) VALUES ($1,$2,$3,$4,$5,$6)`,
        [vendorId, actorId, action, v.status, f.to, (override ? '[Override] ' : '') + (comments || '') || null])
      if (f.to === 'ACTIVE') await client.query(`UPDATE shops SET is_active = true WHERE vendor_id = $1`, [vendorId])
      if (f.to === 'SUSPENDED') await client.query(`UPDATE shop_products sp SET listing_status = 'PAUSED', is_available = false FROM shops s WHERE s.id = sp.shop_id AND s.vendor_id = $1 AND sp.listing_status = 'ACTIVE'`, [vendorId])
      const [title, body] = NOTIFY[action]
      await client.query(
        `INSERT INTO notifications (user_id, title, body, type, data)
         SELECT DISTINCT vu.user_id, $2, $3, 'KYC', $4::jsonb FROM vendor_users vu WHERE vu.vendor_id = $1 AND vu.is_active = true`,
        [vendorId, title, comments ? `${body} ${comments}` : body, JSON.stringify({ vendorId, status: f.to, kind: 'KYC' })])
      await client.query('COMMIT')
      return this.detail(vendorId)
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
  },

  async reviewDocument(vendorId, docId, { status, reason }, actorId) {
    if (!['VERIFIED', 'REJECTED', 'PENDING'].includes(status)) throw err(400, 'Invalid status', 'VALIDATION_ERROR')
    if (status === 'REJECTED' && !String(reason || '').trim()) throw err(400, 'Tell the vendor why this document was rejected', 'VALIDATION_ERROR')
    const { rowCount } = await query(
      `UPDATE vendor_documents SET status = $3, rejection_reason = $4, reviewed_by = $5, reviewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND vendor_id = $2`,
      [docId, vendorId, status, status === 'REJECTED' ? reason.trim() : null, actorId])
    if (!rowCount) throw err(404, 'Document not found', 'NOT_FOUND')
    return this.detail(vendorId)
  },
}
