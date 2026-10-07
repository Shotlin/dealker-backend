import { AdminAbandonedCartsService } from './abandoned-carts.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminAbandonedCartsService()

export class AdminAbandonedCartsController {
  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      shopRole: request.user?.shopRole ?? request.user?.shop_role ?? null,
      shopId: request.shopId ?? request.user?.shopId ?? request.user?.shop_id ?? null,
      permissions: request.user?.permissions ?? [],
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  async list(request, reply) {
    const { page, limit, search, status, minValue, maxValue, sortBy, sortOrder } = request.query
    const data = await svc.list({ page, limit, search, status, minValue, maxValue, sortBy, sortOrder })
    return success(data, 'Abandoned carts fetched')
  }

  async getSummary(request, reply) {
    const data = await svc.getSummary()
    return success(data, 'Abandoned cart summary fetched')
  }

  async getDetail(request, reply) {
    const data = await svc.getDetail(request.params.id)
    if (!data) return reply.code(404).send(error('Abandoned cart not found', 'NOT_FOUND'))
    return success(data, 'Abandoned cart detail fetched')
  }

  async sendReminder(request, reply) {
    const { title, body, imageUrl, deepLink } = request.body
    const result = await svc.sendReminder(
      request.params.id,
      { title, body, imageUrl, deepLink },
      request.user.id,
      request.server
    )
    if (!result.success) {
      const code = result.code === 'NOT_FOUND' ? 404 : result.code === 'REMINDER_TOO_SOON' ? 429 : 400
      return reply.code(code).send(error(result.message, result.code))
    }
    return success({ notificationId: result.notificationId }, 'Reminder sent')
  }

  async sendBulkReminder(request) {
    const { ids, title, body, deepLink } = request.body
    const data = await svc.sendBulkReminder(ids, { title, body, deepLink }, request.user.id, request.server)
    return success(data, `Reminder sent to ${data.sent} of ${data.requested} carts`)
  }

  async getPresets() {
    return success(svc.getPresets(), 'Quick coupon presets')
  }

  async sendQuickCoupon(request, reply) {
    const actor = this._actorCtx(request)
    const result = await svc.sendQuickCoupon(request.params.id, request.body, actor, request.server)
    if (!result.success) {
      const code = result.code === 'NOT_FOUND' ? 404 : 400
      return reply.code(code).send(error(result.message, result.code || 'COUPON_ISSUE_FAILED'))
    }
    const { success: _ok, ...data } = result
    return success(data, 'Quick coupon sent')
  }

  async issueCoupon(request, reply) {
    const actor = this._actorCtx(request)
    const result = await svc.issueCoupon(request.params.id, request.body, actor)
    if (!result.success) {
      const code = result.code === 'NOT_FOUND' ? 404 : 400
      return reply.code(code).send(error(result.message, result.code || 'COUPON_ISSUE_FAILED'))
    }
    return success({ couponId: result.couponId, code: result.code }, 'Coupon issued')
  }
}
