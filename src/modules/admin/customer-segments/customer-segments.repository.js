import { query } from '../../../config/database.js'

/**
 * Customer Segments repository — admin-defined groups of customers used by
 * coupon targeting and notification targeting.
 */
export class CustomerSegmentsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT s.id, s.name, s.description, s.is_active, s.created_by, s.created_at, s.updated_at,
              COALESCE(m.member_count, 0)::int AS member_count
       FROM customer_segments s
       LEFT JOIN (
         SELECT segment_id, COUNT(*)::int AS member_count
         FROM customer_segment_members
         GROUP BY segment_id
       ) m ON m.segment_id = s.id
       ORDER BY s.created_at DESC`
    )
    return rows
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT s.id, s.name, s.description, s.is_active, s.created_by, s.created_at, s.updated_at,
              COALESCE(m.member_count, 0)::int AS member_count
       FROM customer_segments s
       LEFT JOIN (
         SELECT segment_id, COUNT(*)::int AS member_count
         FROM customer_segment_members
         GROUP BY segment_id
       ) m ON m.segment_id = s.id
       WHERE s.id = $1`,
      [id]
    )
    return rows[0] ?? null
  }

  async create({ name, description, createdBy }) {
    const { rows } = await query(
      `INSERT INTO customer_segments (name, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, is_active, created_by, created_at, updated_at`,
      [name, description ?? null, createdBy ?? null]
    )
    return { ...rows[0], member_count: 0 }
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = { name: 'name', description: 'description', isActive: 'is_active' }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE customer_segments SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, description, is_active, created_by, created_at, updated_at`,
      params
    )
    if (!rows[0]) return null
    return this.findById(id)
  }

  async delete(id) {
    const result = await query(`DELETE FROM customer_segments WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  async findMembers(segmentId, { limit, offset }) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.avatar_url, m.added_at
       FROM customer_segment_members m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.segment_id = $1
       ORDER BY m.added_at DESC
       LIMIT $2 OFFSET $3`,
      [segmentId, limit, offset]
    )
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM customer_segment_members WHERE segment_id = $1`,
      [segmentId]
    )
    return { members: rows, total: countRows[0].total }
  }

  async addMembers(segmentId, userIds, addedBy) {
    if (!userIds?.length) return 0
    const { rows } = await query(
      `INSERT INTO customer_segment_members (segment_id, user_id, added_by)
       SELECT $1, uid, $2 FROM UNNEST($3::uuid[]) AS uid
       ON CONFLICT (segment_id, user_id) DO NOTHING
       RETURNING id`,
      [segmentId, addedBy ?? null, userIds]
    )
    return rows.length
  }

  async removeMember(segmentId, userId) {
    const result = await query(
      `DELETE FROM customer_segment_members WHERE segment_id = $1 AND user_id = $2`,
      [segmentId, userId]
    )
    return result.rowCount > 0
  }

  /** Segment IDs a given user currently belongs to — used by coupon targeting checks. */
  async findSegmentIdsForUser(userId) {
    const { rows } = await query(
      `SELECT segment_id FROM customer_segment_members WHERE user_id = $1`,
      [userId]
    )
    return rows.map((r) => r.segment_id)
  }

  /** True if userId is a member of segmentId — used by coupon eligibility checks. */
  async isMember(segmentId, userId) {
    const { rows } = await query(
      `SELECT 1 FROM customer_segment_members WHERE segment_id = $1 AND user_id = $2 LIMIT 1`,
      [segmentId, userId]
    )
    return rows.length > 0
  }
}
