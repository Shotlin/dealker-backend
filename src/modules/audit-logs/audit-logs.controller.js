import { success, error } from '../../utils/apiResponse.js'
import { listAuditLogsQuerySchema } from './audit-logs.schema.js'

/**
 * Audit Logs controller — thin HTTP layer over {@link AuditLogsService}.
 *
 * READ-ONLY by design (R28.3, design §12.4): no create/update/delete
 * handlers exist, and the routes plugin only mounts GET endpoints.
 *
 * Two readers share this controller (design §12.3):
 *   - `list` is invoked from `GET /api/v1/admin/audit-logs` with
 *     `scope.isHQ === true` (task 10.2 wires this).
 *   - The same handler is reused from `GET /api/v1/shop-audit-logs` with
 *     `scope.isHQ === false` and `scope.shopId = request.shopId`
 *     (task 10.3 wires this and adds the second-clause join from R28.7).
 *
 * The route plugin determines which scope to pass; this controller does
 * not infer it from headers or roles so the wiring in tasks 10.2 / 10.3
 * is the single source of truth for "is this an HQ or shop reader?".
 *
 * Requirements: R28.3, R28.6, R28.7
 * Design:       §10, §12.3 of .kiro/specs/multi-vendor-system/design.md
 */
export class AuditLogsController {
  /**
   * @param {import('./audit-logs.service.js').AuditLogsService} service
   */
  constructor(service) {
    if (!service) {
      throw new TypeError('AuditLogsController requires a service')
    }
    this.service = service
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')
  }

  /**
   * Build the scope object the service expects from the Fastify request.
   *
   * Resolution rules:
   *   - HQ user (platform role ADMIN, SUPER_ADMIN, HQ_MANAGER, HQ_FINANCE,
   *     HQ_SUPPORT) → `isHQ = true`. `shopId` is taken from
   *     `request.shopId` when an HQ user has explicitly selected a shop
   *     via `requireShopScope` (the shop-scoped reader path may still
   *     want the user-selected shop to drive the actor_shop_id filter
   *     defensively); otherwise null.
   *   - Anyone else → `isHQ = false`. `shopId` comes from `request.shopId`
   *     (set by the `requireShopScope` middleware on the shop reader
   *     route). When the route is the HQ reader and the requester is a
   *     non-HQ user, the route-level permission check in tasks 10.2 /
   *     10.3 has already rejected the request, so this branch is
   *     defensive.
   *
   * @private
   */
  _resolveScope(request) {
    const platformRole = request.user?.platformRole || request.user?.platform_role
    const role = request.user?.role
    const HQ_ROLES = new Set([
      'ADMIN',
      'SUPER_ADMIN',
      'HQ_MANAGER',
      'HQ_FINANCE',
      'HQ_SUPPORT',
    ])
    const isHQ = HQ_ROLES.has(platformRole) || HQ_ROLES.has(role)
    const shopId = request.shopId || null
    return { isHQ, shopId }
  }

  /**
   * `GET` handler used by both audit-log readers.
   *
   * Validates the query string with {@link listAuditLogsQuerySchema},
   * resolves the scope from the request, and delegates to the service.
   * The service's typed `SHOP_SCOPE_REQUIRED` error is translated to a
   * 400 with the canonical error code so the response shape stays
   * consistent with the rest of the platform's error envelopes.
   *
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  async list(request, reply) {
    const parsed = listAuditLogsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    // Defensive bound check on the date range — Zod coerces individually
    // but does not enforce ordering between two optional fields.
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      return reply
        .code(400)
        .send(error('from must be on or before to', 'VALIDATION_ERROR'))
    }

    const scope = this._resolveScope(request)

    try {
      const result = await this.service.list(parsed.data, scope)
      return reply.code(200).send(success(result, 'Audit logs fetched'))
    } catch (err) {
      if (err && err.code === 'SHOP_SCOPE_REQUIRED') {
        return reply
          .code(400)
          .send(
            error(
              'Shop scope is required for shop-audit-logs reads',
              'SHOP_SCOPE_REQUIRED',
            ),
          )
      }
      throw err
    }
  }
}
