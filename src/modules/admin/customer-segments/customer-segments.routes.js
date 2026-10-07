import { CustomerSegmentsController } from './customer-segments.controller.js'
import { CustomerSegmentsService } from './customer-segments.service.js'
import { CustomerSegmentsRepository } from './customer-segments.repository.js'
import {
  listSegmentsSchema,
  segmentIdSchema,
  createSegmentSchema,
  updateSegmentSchema,
  listMembersSchema,
  addMembersSchema,
  removeMemberSchema,
  searchCandidatesSchema,
} from './customer-segments.schema.js'

/**
 * Customer Segments routes plugin
 * Mounted at /api/v1/admin/customer-segments (see admin.routes.js)
 */
export default async function adminCustomerSegmentsRoutes(fastify) {
  const repository = new CustomerSegmentsRepository()
  const service = new CustomerSegmentsService(repository)
  const controller = new CustomerSegmentsController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listSegmentsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createSegmentSchema }, controller.create.bind(controller))
  fastify.get('/:id', { schema: segmentIdSchema }, controller.getDetail.bind(controller))
  fastify.patch('/:id', { schema: updateSegmentSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: segmentIdSchema }, controller.delete.bind(controller))

  fastify.get('/:id/members', { schema: listMembersSchema }, controller.getMembers.bind(controller))
  fastify.post('/:id/members', { schema: addMembersSchema }, controller.addMembers.bind(controller))
  fastify.delete('/:id/members/:userId', { schema: removeMemberSchema }, controller.removeMember.bind(controller))

  fastify.get('/:id/search-candidates', { schema: searchCandidatesSchema }, controller.searchCandidates.bind(controller))
}
