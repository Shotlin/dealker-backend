import { AuditLogsController } from './audit-logs.controller.js'
import { AuditLogsService } from './audit-logs.service.js'
import { AuditLogsRepository } from './audit-logs.repository.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'

/**
 * Audit Logs routes plugin — mounts the two read-only endpoints:
 *
 *   - GET /api/v1/admin/audit-logs   (task 10.2 — HQ-only, perm `audit_logs.view`)
 *   - GET /api/v1/shop-audit-logs    (task 10.3 — shop-scoped, perm `audit_logs.view`)
 *
 * READ-ONLY by design (R28.3, design §12.4): no POST / PATCH / PUT / DELETE
 * routes exist. The INSERT path lives in `src/utils/audit-log.js`.
 *
 * Requirements: R28.3, R28.6, R28.7
 * Design:       §10, §12.3 of .kiro/specs/multi-vendor-system/design.md
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function auditLogsRoutes(fastify) {
  const repository = new AuditLogsRepository()
  const service = new AuditLogsService(repository)
  const controller = new AuditLogsController(service)

  // Expose the wired graph on the encapsulated context.
  fastify.decorate('auditLogs', { repository, service, controller })
}

/**
 * HQ-only audit-logs reader (task 10.2).
 * Mounted at: GET /api/v1/admin/audit-logs
 *
 * Requires:
 *   - Valid JWT (fastify.authenticate)
 *   - `audit_logs.view` permission (HQ roles carry this)
 *
 * The controller resolves scope as `isHQ = true` for HQ users, so no
 * shop filter is forced — HQ sees all rows, optionally narrowed by
 * query-string filters.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function adminAuditLogsRoutes(fastify) {
  const repository = new AuditLogsRepository()
  const service = new AuditLogsService(repository)
  const controller = new AuditLogsController(service)

  fastify.get('/', {
    schema: {
      tags: ['Audit Logs'],
      summary: 'List audit logs (HQ-only)',
      description:
        'Paginated, filterable list of all audit log entries. ' +
        'Requires `audit_logs.view` permission (HQ roles only).',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          actor_user_id: { type: 'string', format: 'uuid' },
          actor_shop_id: { type: 'string', format: 'uuid' },
          target_type: { type: 'string', minLength: 1, maxLength: 50 },
          target_id: { type: 'string', format: 'uuid' },
          action: { type: 'string', minLength: 1, maxLength: 80 },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      requirePermission('audit_logs.view'),
    ],
  }, controller.list.bind(controller))
}

/**
 * Shop-scoped audit-logs reader (task 10.3).
 * Mounted at: GET /api/v1/shop-audit-logs
 *
 * Requires:
 *   - Valid JWT (fastify.authenticate)
 *   - Shop scope (requireShopScope — sets request.shopId)
 *   - `audit_logs.view` permission
 *
 * The controller resolves scope with `shopId = request.shopId`. The service
 * forces `actor_shop_id = scope.shopId` so shop users only see rows where
 * the actor was operating within their shop context.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function shopAuditLogsRoutes(fastify) {
  const repository = new AuditLogsRepository()
  const service = new AuditLogsService(repository)
  const controller = new AuditLogsController(service)

  const shopScope = requireShopScope({ requireShop: true })

  fastify.get('/', {
    schema: {
      tags: ['Audit Logs'],
      summary: 'List audit logs (shop-scoped)',
      description:
        'Paginated, filterable list of audit log entries scoped to the ' +
        'active shop. Returns only rows where actor_shop_id matches the ' +
        "caller's active shop. Requires `audit_logs.view` permission " +
        'and shop scope.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          actor_user_id: { type: 'string', format: 'uuid' },
          target_type: { type: 'string', minLength: 1, maxLength: 50 },
          target_id: { type: 'string', format: 'uuid' },
          action: { type: 'string', minLength: 1, maxLength: 80 },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
    preHandler: [
      fastify.authenticate,
      shopScope,
      requirePermission('audit_logs.view'),
    ],
  }, controller.list.bind(controller))
}

// Re-export the public classes so other modules can construct their own wiring.
export { AuditLogsRepository, AuditLogsService, AuditLogsController }
