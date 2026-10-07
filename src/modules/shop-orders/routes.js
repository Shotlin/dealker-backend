import { ShopOrdersController } from './controller.js'
import { ShopOrdersService } from './service.js'
import { ShopOrdersRepository } from './repository.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'

/**
 * Shop Orders routes plugin.
 * Prefix: /api/v1/shop-orders (mounted in src/app.js).
 *
 * Authorization model (design §6.5, R22):
 *   - Every route requires `fastify.authenticate` + `requireShopScope({ requireShop: true })`
 *     so HQ users either pin a shop via X-Shop-Id or are rejected with
 *     400 SHOP_SCOPE_REQUIRED.
 *   - Permission strings are drawn from the canonical 37-string vocabulary
 *     defined in `src/utils/permissions.js` (R17 AC#1).
 *   - The boot-time route audit (utils/permission-audit.js) verifies every
 *     route under the /api/v1/shop-orders prefix declares one of these.
 *
 * Permission map (R22 AC#2):
 *   GET    /                     → shop_orders.view
 *   GET    /export               → shop_orders.export
 *   GET    /riders               → riders.view (R25 AC#6)
 *   GET    /:orderId             → shop_orders.view
 *   GET    /:orderId/packing-slip → shop_orders.view
 *   POST   /:orderId/confirm     → shop_orders.update_status
 *   POST   /:orderId/preparing   → shop_orders.update_status
 *   POST   /:orderId/packed      → shop_orders.update_status
 *   POST   /:orderId/assign-rider → shop_orders.assign_rider
 *   POST   /:orderId/cancel      → shop_orders.cancel
 *   POST   /:orderId/refund      → shop_orders.refund
 */
export default async function shopOrdersRoutes(fastify) {
  const repository = new ShopOrdersRepository()
  const service = new ShopOrdersService(repository, { fastify })
  const controller = new ShopOrdersController(service)

  const shopScope = requireShopScope({ requireShop: true })
  const auth = fastify.authenticate

  // Reusable param schema for the orderId path parameter — keeps the
  // routes uniform and gives the OpenAPI doc a single source of truth.
  const orderIdParam = {
    type: 'object',
    required: ['orderId'],
    properties: { orderId: { type: 'string', format: 'uuid' } },
  }

  // ── Static collection endpoints (declared first so they can never be
  //    shadowed by a future /:orderId match).

  // GET / — list orders (R22 AC#3, AC#4)
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'List shop orders',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: {
              type: 'string',
              enum: [
                'PENDING',
                'CONFIRMED',
                'PREPARING',
                'PACKED',
                'OUT_FOR_DELIVERY',
                'DELIVERED',
                'CANCELLED',
                'REFUNDED',
              ],
            },
            payment_status: {
              type: 'string',
              enum: ['PENDING', 'PAID', 'FAILED', 'REFUNDED'],
            },
            created_at_from: { type: 'string' },
            created_at_to: { type: 'string' },
            q: { type: 'string', maxLength: 200 },
          },
        },
      },
      config: { requiredPermission: 'shop_orders.view' },
      preHandler: [auth, shopScope, requirePermission('shop_orders.view')],
    },
    controller.list.bind(controller)
  )

  // GET /export — streamed CSV (R22 AC#12)
  fastify.get(
    '/export',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Export shop orders as CSV (max 10000 rows)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            payment_status: { type: 'string' },
            created_at_from: { type: 'string' },
            created_at_to: { type: 'string' },
            q: { type: 'string', maxLength: 200 },
          },
        },
      },
      config: { requiredPermission: 'shop_orders.export' },
      preHandler: [auth, shopScope, requirePermission('shop_orders.export')],
    },
    controller.exportCsv.bind(controller)
  )

  // GET /riders — riders currently assigned for this shop (R25 AC#6)
  fastify.get(
    '/riders',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'List riders currently assigned to this shop',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
      config: { requiredPermission: 'riders.view' },
      preHandler: [auth, shopScope, requirePermission('riders.view')],
    },
    controller.listRiders.bind(controller)
  )

  // ── Order-scoped endpoints ──────────────────────────────────────

  // GET /:orderId — single order detail
  fastify.get(
    '/:orderId',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Get a single order belonging to this shop',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
      },
      config: { requiredPermission: 'shop_orders.view' },
      preHandler: [auth, shopScope, requirePermission('shop_orders.view')],
    },
    controller.getOne.bind(controller)
  )

  // GET /:orderId/packing-slip — printable HTML (R22 AC#11)
  fastify.get(
    '/:orderId/packing-slip',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Render printable HTML packing slip',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
      },
      config: { requiredPermission: 'shop_orders.view' },
      preHandler: [auth, shopScope, requirePermission('shop_orders.view')],
    },
    controller.packingSlip.bind(controller)
  )

  // POST /:orderId/confirm — PENDING → CONFIRMED (R22 AC#5)
  fastify.post(
    '/:orderId/confirm',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Confirm an order (PENDING → CONFIRMED)',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
      },
      config: { requiredPermission: 'shop_orders.update_status' },
      preHandler: [
        auth,
        shopScope,
        requirePermission('shop_orders.update_status'),
      ],
    },
    controller.confirm.bind(controller)
  )

  // POST /:orderId/preparing — CONFIRMED → PREPARING (R22 AC#6)
  fastify.post(
    '/:orderId/preparing',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Mark order as preparing (CONFIRMED → PREPARING)',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
      },
      config: { requiredPermission: 'shop_orders.update_status' },
      preHandler: [
        auth,
        shopScope,
        requirePermission('shop_orders.update_status'),
      ],
    },
    controller.preparing.bind(controller)
  )

  // POST /:orderId/packed — PREPARING → PACKED (R22 AC#7)
  fastify.post(
    '/:orderId/packed',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Mark order as packed (PREPARING → PACKED)',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
      },
      config: { requiredPermission: 'shop_orders.update_status' },
      preHandler: [
        auth,
        shopScope,
        requirePermission('shop_orders.update_status'),
      ],
    },
    controller.packed.bind(controller)
  )

  // POST /:orderId/assign-rider (R22 AC#8)
  fastify.post(
    '/:orderId/assign-rider',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Assign a rider to an order',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
        body: {
          type: 'object',
          required: ['rider_id'],
          properties: { rider_id: { type: 'string', format: 'uuid' } },
        },
      },
      config: { requiredPermission: 'shop_orders.assign_rider' },
      preHandler: [
        auth,
        shopScope,
        requirePermission('shop_orders.assign_rider'),
      ],
    },
    controller.assignRider.bind(controller)
  )

  // POST /:orderId/cancel — PENDING|CONFIRMED|PREPARING|PACKED → CANCELLED (R22 AC#9)
  fastify.post(
    '/:orderId/cancel',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Cancel an order',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 10, maxLength: 500 },
          },
        },
      },
      config: { requiredPermission: 'shop_orders.cancel' },
      preHandler: [auth, shopScope, requirePermission('shop_orders.cancel')],
    },
    controller.cancel.bind(controller)
  )

  // POST /:orderId/refund — DELIVERED → REFUNDED (R22 AC#10)
  fastify.post(
    '/:orderId/refund',
    {
      schema: {
        tags: ['Shop Orders'],
        summary: 'Refund a delivered order',
        security: [{ bearerAuth: [] }],
        params: orderIdParam,
        body: {
          type: 'object',
          required: ['reason', 'amount'],
          properties: {
            reason: { type: 'string', minLength: 10, maxLength: 500 },
            amount: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
      config: { requiredPermission: 'shop_orders.refund' },
      preHandler: [auth, shopScope, requirePermission('shop_orders.refund')],
    },
    controller.refund.bind(controller)
  )
}
