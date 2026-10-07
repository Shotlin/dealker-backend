import { OverviewRepository } from './overview.repository.js'
import { OverviewService } from './overview.service.js'
import { requireShopScope } from '../../../middlewares/shop-scope.js'
import { success } from '../../../utils/apiResponse.js'
import { cacheGet, cacheSet } from '../../../utils/cache.js'

const querySchema = {
  type: 'object',
  properties: {
    range: { type: 'string', enum: ['today', 'yesterday', '7d', '30d', 'custom'], default: '7d' },
    from: { type: 'string', maxLength: 10 },
    to: { type: 'string', maxLength: 10 },
    shopId: { type: 'string', format: 'uuid' },
    pincode: { type: 'string', maxLength: 12 },
  },
}

/**
 * Business Overview — one read-only endpoint feeding the dashboard's
 * Overview page. Prefix: /api/v1/admin/overview
 */
export default async function overviewRoutes(fastify) {
  const service = new OverviewService(new OverviewRepository())
  const shopScope = requireShopScope()

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
    if (reply.sent) return
    // Shop staff are pinned to their own shop: every query below is filtered
    // by request.shopId, so profit/margin of other branches is never exposed.
    await shopScope(request, reply)
  })

  fastify.get('/', { schema: { querystring: querySchema } }, async (request, reply) => {
    const q = request.query
    const scoped = request.shopId || null
    // Short cache: the page re-polls, and the aggregation is the heaviest
    // admin query. Keyed by every input that changes the result.
    const key = `bakaloo:overview:v1:${scoped || q.shopId || 'all'}:${q.pincode || '-'}:${q.range || '7d'}:${q.from || '-'}:${q.to || '-'}`
    const cached = await cacheGet(key)
    if (cached) return reply.send(success(cached, 'Overview fetched'))
    const data = await service.getOverview(q, scoped)
    if (Object.keys(data.section_errors).length === 0) await cacheSet(key, data, 45)
    return reply.send(success(data, 'Overview fetched'))
  })
}
