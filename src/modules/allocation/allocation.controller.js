import { success, error } from '../../utils/apiResponse.js'
import { recomputeBodySchema } from './allocation.schema.js'
import { ROLES } from '../../constants/roles.js'

/**
 * Allocation controller — thin HTTP layer.
 * Handles request/response shape only and delegates to the service.
 *
 * Endpoints:
 *   - GET  /api/v1/allocation/my-shops   — Customer's allocated shops (Req 4.5)
 *   - POST /api/v1/allocation/recompute  — Internal/admin trigger; admin can
 *     target any user, others can only target self.
 */
export class AllocationController {
  constructor(service) {
    this.service = service
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')
  }

  /** @private */
  _statusForCode(code) {
    switch (code) {
      case 'NO_COORDINATES':
      case 'NO_PINCODE':
      case 'USER_ID_REQUIRED':
      case 'VALIDATION_ERROR':
        return 400
      case 'UNAUTHORIZED':
        return 401
      case 'FORBIDDEN':
        return 403
      case 'USER_NOT_FOUND':
      case 'NOT_FOUND':
        return 404
      default:
        return 400
    }
  }

  // ────────────────────────────────────────────────────────
  // GET /my-shops
  // ────────────────────────────────────────────────────────
  async myShops(request, reply) {
    const userId = request.user?.id
    if (!userId) {
      return reply
        .code(401)
        .send(error('Unauthorized — authentication required', 'UNAUTHORIZED'))
    }

    const data = await this.service.getForUser(userId)
    return reply.code(200).send(success(data, 'Allocated shops fetched'))
  }

  // ────────────────────────────────────────────────────────
  // POST /recompute
  // ────────────────────────────────────────────────────────
  async recompute(request, reply) {
    const actor = request.user
    if (!actor?.id) {
      return reply
        .code(401)
        .send(error('Unauthorized — authentication required', 'UNAUTHORIZED'))
    }

    const parsed = recomputeBodySchema.safeParse(request.body || {})
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const targetUserId = parsed.data.user_id || actor.id

    // Authorization: ADMIN can target any user; everyone else only themselves.
    if (targetUserId !== actor.id && actor.role !== ROLES.ADMIN) {
      return reply
        .code(403)
        .send(
          error(
            'Forbidden — only ADMIN can recompute allocations for another user',
            'FORBIDDEN'
          )
        )
    }

    if (!parsed.data.address) {
      return reply
        .code(400)
        .send(
          error(
            'address (lat, lng, pincode) is required to recompute allocations',
            'NO_COORDINATES'
          )
        )
    }

    const result = await this.service.computeAndUpsertForUser(
      targetUserId,
      parsed.data.address
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.data, 'Allocations recomputed'))
  }
}
