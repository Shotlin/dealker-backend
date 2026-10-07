import { query } from '../../../config/database.js'
import { success } from '../../../utils/apiResponse.js'

export default async function adminActivityLogRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          adminId: { type: 'string' },
          action: { type: 'string' },
          entityType: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { page = 1, limit = 50, adminId, action, entityType } = request.query
    const offset = (page - 1) * limit
    const params = []
    const clauses = []
    let idx = 1

    if (adminId) { clauses.push(`c.admin_id = $${idx++}`); params.push(adminId) }
    if (action) { clauses.push(`c.action = $${idx++}`); params.push(action) }
    if (entityType) { clauses.push(`c.entity_type = $${idx++}`); params.push(entityType) }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

    // Two independent audit systems exist: admin_activity_log (most admin
    // actions) and audit_logs (shop_products mutations, plus auth/security
    // events) — this UNION merges both into one feed so a shop-listing
    // price edit shows up here instead of requiring a direct DB
    // investigation to find. Column names on the combined CTE match
    // admin_activity_log's original shape so the response contract (and
    // the dashboard's ActivityLog type) is unchanged.
    const combinedCte = `
      WITH combined AS (
        SELECT id, admin_id, action, entity_type, entity_id,
               old_value, new_value, ip_address::text AS ip_address, created_at
          FROM admin_activity_log
        UNION ALL
        SELECT id, actor_user_id AS admin_id, action, target_type AS entity_type, target_id AS entity_id,
               before AS old_value, after AS new_value, ip_address::text AS ip_address, created_at
          FROM audit_logs
      )
    `

    const { rows } = await query(
      `${combinedCte}
       SELECT c.*, u.name AS admin_name
         FROM combined c
         LEFT JOIN users u ON u.id = c.admin_id
         ${where}
        ORDER BY c.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `${combinedCte}
       SELECT COUNT(*)::int AS total FROM combined c ${where}`,
      params
    )

    return success({
      logs: rows,
      total: countRes.rows[0].total,
      page,
      limit,
    }, 'Activity log fetched')
  })
}
