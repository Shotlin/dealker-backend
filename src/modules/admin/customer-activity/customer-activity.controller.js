import { success, error } from '../../../utils/apiResponse.js'

export class CustomerActivityController {
  constructor(service) {
    this.service = service
  }

  /** GET /resolve-user — Resolve a User ID or phone to name/phone/last_active_at */
  async resolveUser(request, reply) {
    const result = await this.service.resolveUser(request.query.query)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'USER_NOT_FOUND'))
    }
    return reply.send(success(result.user, 'User found'))
  }

  /** GET /search-users — Real-time search-as-you-type suggestions */
  async searchUsers(request, reply) {
    const users = await this.service.searchUsers(request.query.query)
    return reply.send(success(users, 'Users found'))
  }

  /** GET /:userId/timeline — Paginated, filterable activity timeline */
  async getTimeline(request, reply) {
    const { events, pagination } = await this.service.getTimeline(
      request.params.userId,
      request.query
    )
    return reply.send(success(events, 'Activity timeline fetched', { pagination }))
  }
}
