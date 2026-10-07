import { CustomerActivityController } from './customer-activity.controller.js'
import { CustomerActivityService } from './customer-activity.service.js'
import { CustomerActivityRepository } from './customer-activity.repository.js'
import {
  resolveCustomerActivityUserSchema,
  searchCustomerActivityUsersSchema,
  getCustomerActivityTimelineSchema,
} from './customer-activity.schema.js'

/**
 * Customer Activity routes plugin
 * Prefix: /api/v1/admin/customer-activity
 *
 * Distinct from /admin/activity-log (which logs ADMIN actions) — this logs
 * what a CUSTOMER did, merged from every table that records a real
 * customer action, for support/ops investigation of a specific user.
 */
export default async function customerActivityRoutes(fastify) {
  const repository = new CustomerActivityRepository()
  const service = new CustomerActivityService(repository)
  const controller = new CustomerActivityController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  // GET /resolve-user — Resolve a User ID or phone to name/phone/last_active_at
  fastify.get('/resolve-user', {
    schema: resolveCustomerActivityUserSchema,
  }, controller.resolveUser.bind(controller))

  // GET /search-users — Real-time search-as-you-type suggestions
  fastify.get('/search-users', {
    schema: searchCustomerActivityUsersSchema,
  }, controller.searchUsers.bind(controller))

  // GET /:userId/timeline — Paginated, filterable activity timeline
  fastify.get('/:userId/timeline', {
    schema: getCustomerActivityTimelineSchema,
  }, controller.getTimeline.bind(controller))
}
