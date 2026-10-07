import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'
import { UsersRepository } from './users.repository.js'
import {
  getProfileSchema,
  updateProfileSchema,
  uploadAvatarSchema,
  getStatsSchema,
} from './users.schema.js'

/**
 * Users routes plugin
 * Prefix: /api/v1/users (set in app.js)
 * All routes require authentication
 */
export default async function usersRoutes(fastify) {
  const repository = new UsersRepository()
  const service = new UsersService(repository)
  const controller = new UsersController(service)

  // GET /me — Current user profile
  fastify.get('/me', {
    schema: getProfileSchema,
    preHandler: [fastify.authenticate],
  }, controller.getProfile.bind(controller))

  // PUT /me — Update profile
  fastify.put('/me', {
    schema: updateProfileSchema,
    preHandler: [fastify.authenticate],
  }, controller.updateProfile.bind(controller))

  // PUT /me/avatar — Upload profile photo
  fastify.put('/me/avatar', {
    schema: uploadAvatarSchema,
    preHandler: [fastify.authenticate],
  }, controller.uploadAvatar.bind(controller))

  // GET /me/stats — Order count, total spent, loyalty points
  fastify.get('/me/stats', {
    schema: getStatsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getStats.bind(controller))
}
