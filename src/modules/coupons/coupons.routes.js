import { CouponsController } from './coupons.controller.js'
import { CouponsService } from './coupons.service.js'
import { CouponsRepository } from './coupons.repository.js'
import { CartService } from '../cart/cart.service.js'
import { CartRepository } from '../cart/cart.repository.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import {
  validateCouponSchema,
  availableCouponsSchema,
  listCouponsAdminSchema,
  createCouponSchema,
  updateCouponSchema,
  deleteCouponSchema,
  couponAnalyticsSchema,
} from './coupons.schema.js'

/**
 * Coupons routes plugin
 * Prefix: /api/v1/coupons
 *
 * Task 9.2: Admin create route now uses requirePermission('shop_coupons.create')
 * instead of the blanket authorize(['ADMIN']) so SHOP_ADMIN/SHOP_MANAGER with
 * the permission can also create SHOP_COUPONs. Scope enforcement (PLATFORM vs
 * SHOP) is handled in the service layer.
 */
export default async function couponsRoutes(fastify) {
  const repository = new CouponsRepository()
  const service = new CouponsService(repository)
  const cartService = new CartService(new CartRepository())
  const controller = new CouponsController(service, cartService)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // POST /validate — Validate coupon for cart
  fastify.post('/validate', {
    schema: validateCouponSchema,
    preHandler: [fastify.authenticate],
  }, controller.validate.bind(controller))

  // GET /available — List available coupons
  fastify.get('/available', {
    schema: availableCouponsSchema,
    preHandler: [fastify.authenticate],
  }, controller.available.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // GET / — All coupons [ADMIN]
  fastify.get('/', {
    schema: listCouponsAdminSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.listAll.bind(controller))

  // POST / — Create coupon [HQ or shop staff with shop_coupons.create]
  // Task 9.2: scope enforcement is in the service layer; the route gate
  // uses requirePermission so both HQ_Users and shop staff with the
  // canonical permission can reach the handler.
  fastify.post('/', {
    schema: createCouponSchema,
    preHandler: [fastify.authenticate, requirePermission('shop_coupons.create')],
  }, controller.create.bind(controller))

  // GET /:id/target-users — Individually-targeted customers [ADMIN]
  fastify.get('/:id/target-users', {
    preHandler: [fastify.authenticate, requirePermission('shop_coupons.view')],
  }, controller.getTargetUsers.bind(controller))

  // GET /:id/analytics — Redemption/revenue stats for the dashboard drawer [ADMIN]
  fastify.get('/:id/analytics', {
    schema: couponAnalyticsSchema,
    preHandler: [fastify.authenticate, requirePermission('shop_coupons.view')],
  }, controller.getAnalytics.bind(controller))

  // PUT /:id — Update coupon [HQ or shop staff with shop_coupons.update]
  fastify.put('/:id', {
    schema: updateCouponSchema,
    preHandler: [fastify.authenticate, requirePermission('shop_coupons.update')],
  }, controller.update.bind(controller))

  // DELETE /:id — Delete coupon [HQ or shop staff with shop_coupons.delete]
  fastify.delete('/:id', {
    schema: deleteCouponSchema,
    preHandler: [fastify.authenticate, requirePermission('shop_coupons.delete')],
  }, controller.delete.bind(controller))
}
