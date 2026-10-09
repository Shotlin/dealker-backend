import { query } from '../../../config/database.js'
import { success, error } from '../../../utils/apiResponse.js'

/**
 * Admin: the top-of-home store tiles (label / icon / order / visibility).
 * Prefix: /api/v1/admin/storefront-stores. The public read is GET /api/v1/theme/stores.
 */
export default async function adminStorefrontStoreRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', async () => {
    const { rows } = await query(
      `SELECT store_key, label, icon_url, sort_order, is_active, updated_at
         FROM storefront_stores ORDER BY sort_order ASC, label ASC`,
    )
    return success(rows, 'Storefront stores')
  })

  fastify.put('/:key', {
    schema: {
      params: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 50 } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 100 },
          icon_url: { type: ['string', 'null'], maxLength: 1000 },
          sort_order: { type: 'integer', minimum: 0, maximum: 999 },
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { label, icon_url, sort_order, is_active } = request.body
    const { rows } = await query(
      `UPDATE storefront_stores SET
          label = COALESCE($2, label),
          icon_url = CASE WHEN $3::boolean THEN $4 ELSE icon_url END,
          sort_order = COALESCE($5, sort_order),
          is_active = COALESCE($6, is_active),
          updated_at = NOW()
        WHERE store_key = $1
        RETURNING store_key, label, icon_url, sort_order, is_active, updated_at`,
      [request.params.key, label ?? null, Object.prototype.hasOwnProperty.call(request.body, 'icon_url'), icon_url ?? null, sort_order ?? null, is_active ?? null],
    )
    if (!rows.length) return reply.code(404).send(error('Store not found', 'NOT_FOUND'))
    return success(rows[0], 'Store updated')
  })
}
