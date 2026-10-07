import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { AdminCustomersRepository } from '../customers/customers.repository.js'
import { CustomerSegmentsRepository } from './customer-segments.repository.js'

export class CustomerSegmentsService {
  constructor(repository = new CustomerSegmentsRepository()) {
    this.repo = repository
    this.customersRepo = new AdminCustomersRepository()
  }

  async list() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  async create(data, actor) {
    if (!data.name || !data.name.trim()) {
      return { success: false, message: 'Segment name is required' }
    }

    const segment = await this.repo.create({
      name: data.name.trim(),
      description: data.description ?? null,
      createdBy: actor.userId,
    })

    emitAudit('customer_segment_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segment.id,
      before: null,
      after: segment,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: segment.id, actor: actor.userId }, 'Customer segment created')
    return { success: true, segment }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Segment not found' }
    }

    const segment = await this.repo.update(id, data)

    emitAudit('customer_segment_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: id,
      before: existing,
      after: segment,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: id, actor: actor.userId }, 'Customer segment updated')
    return { success: true, segment }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Segment not found' }
    }

    await this.repo.delete(id)

    emitAudit('customer_segment_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: id, actor: actor.userId }, 'Customer segment deleted')
    return { success: true }
  }

  async getMembers(segmentId, { page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const { members, total } = await this.repo.findMembers(segmentId, { limit, offset })
    return {
      members,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async addMembers(segmentId, userIds, actor) {
    const segment = await this.repo.findById(segmentId)
    if (!segment) {
      return { success: false, message: 'Segment not found' }
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return { success: false, message: 'userIds must be a non-empty array' }
    }

    const addedCount = await this.repo.addMembers(segmentId, userIds, actor.userId)

    emitAudit('customer_segment_members_added', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segmentId,
      before: null,
      after: { userIds },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId, addedCount, actor: actor.userId }, 'Customer segment members added')
    return { success: true, addedCount }
  }

  async removeMember(segmentId, userId, actor) {
    const removed = await this.repo.removeMember(segmentId, userId)
    if (!removed) {
      return { success: false, message: 'Member not found in segment' }
    }

    emitAudit('customer_segment_member_removed', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segmentId,
      before: { userId },
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    return { success: true }
  }

  /** Search customers to add to a segment — reuses the existing admin customer search. */
  async searchCandidates(q, { limit = 20 } = {}) {
    const { customers } = await this.customersRepo.findAll({
      offset: 0,
      limit,
      search: q,
      status: undefined,
    })
    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      avatar_url: c.avatar_url,
    }))
  }
}
