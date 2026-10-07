import { getOffsetLimit, buildPagination } from '../../../utils/paginate.js'

export class CustomerActivityService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Resolve a User ID or phone number to the matching user, including
   * last_active_at — the only "login activity" signal that exists (a
   * single rolling last-seen timestamp, not a history of individual
   * logins; no such log is recorded anywhere in this system).
   */
  async resolveUser(input) {
    const user = await this.repo.resolveUser(input)
    if (!user) return { success: false, message: 'No user found for this ID or phone number' }
    return { success: true, user }
  }

  /** Real-time search-as-you-type suggestions (see repository for matching rules). */
  async searchUsers(input) {
    return this.repo.searchUsers(input)
  }

  /**
   * Paginated, filterable activity timeline for one user.
   */
  async getTimeline(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const { events, total } = await this.repo.getTimeline(userId, {
      eventType: filters.eventType,
      from: filters.from,
      to: filters.to,
      limit,
      offset,
    })

    return {
      events,
      pagination: buildPagination({ page: filters.page || 1, limit, total }),
    }
  }
}
