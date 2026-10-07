import { success, error } from '../../utils/apiResponse.js'
import {
  createShopStaffSchema,
  updateShopStaffSchema,
  listShopStaffQuerySchema,
  shopStaffIdParamSchema,
} from './shop-staff.schema.js'

/**
 * Resolve shop_id for shop-scoped operations (list/get/update/delete).
 *
 * Resolution order:
 *   1. URL param `:shopId` — set when routes are mounted under
 *      `/shops/:shopId/staff` (the dashboard's canonical pattern, see
 *      bakaloo-dashboard/src/services/shop-staff.service.ts). Wins over
 *      headers/JWT so a Super Admin operating on shop A can't accidentally
 *      hit shop B by leaving a stale X-Shop-Id header set.
 *   2. JWT shop_id (request.user.shopId or request.user.shop_id) — set after
 *      staff selects a shop
 *   3. X-Shop-Id header — used by Super Admin (platform ADMIN) when
 *      impersonating a shop
 *
 * Returns null when no shop_id is available.
 *
 * NOTE: Task 2.3 will replace this helper with dedicated shop-scope middleware.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string|null}
 */
function resolveShopId(request) {
  return (
    request.params?.shopId ||
    request.user?.shopId ||
    request.user?.shop_id ||
    request.headers['x-shop-id'] ||
    null
  )
}

/**
 * Shop Staff controller — thin HTTP layer.
 * Handles request/response shape only and delegates to the service.
 */
export class ShopStaffController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST / — Assign a staff member to a shop.
   * Body: { shop_id, user_id, role, permissions[] }
   * Response: 201 Created
   */
  async create(request, reply) {
    const parsed = createShopStaffSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(
        error(
          parsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          'VALIDATION_ERROR'
        )
      )
    }

    const result = await this.service.create(parsed.data, request.user.id)

    if (!result.success) {
      const statusCode = result.code === 'STAFF_NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(201).send(success(result.data, 'Staff member assigned'))
  }

  /**
   * GET / — List staff for the authenticated shop.
   * Scoped via JWT shop_id or X-Shop-Id header (super admin).
   */
  async list(request, reply) {
    const parsed = listShopStaffQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send(
        error(
          parsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          'VALIDATION_ERROR'
        )
      )
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('shop_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.list(shopId, parsed.data)
    return reply.code(200).send(success(result, 'Staff list fetched'))
  }

  /**
   * GET /:id — Get a single staff record (scoped to shop_id).
   */
  async getOne(request, reply) {
    const paramsParsed = shopStaffIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('shop_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const record = await this.service.getById(paramsParsed.data.id, shopId)
    if (!record) {
      return reply.code(404).send(error('Staff record not found', 'STAFF_NOT_FOUND'))
    }

    return reply.code(200).send(success(record, 'Staff record fetched'))
  }

  /**
   * PATCH /:id — Update staff role, permissions, or is_active flag.
   *
   * PATCH semantics (R29 AC#2): only the fields present in the body are
   * applied; absent fields are unchanged. R29 AC#8 — empty body is
   * rejected with 400 VALIDATION_ERROR by the schema's `.refine` rule.
   *
   * Forwards `ip` and `request.user-agent` to the service so the
   * `staff_updated` audit row carries request metadata (R28 AC#4).
   */
  async update(request, reply) {
    const paramsParsed = shopStaffIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = updateShopStaffSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply.code(400).send(
        error(
          bodyParsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          'VALIDATION_ERROR'
        )
      )
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('shop_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    let result
    try {
      result = await this.service.update(
        paramsParsed.data.id,
        bodyParsed.data,
        shopId,
        request.user.id,
        {
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        },
      )
    } catch (err) {
      // Service throws `{ statusCode, code, message }` for the
      // empty-body and PERMISSION_INVALID branches (mirrors the
      // pattern used by the admin/auth controller's mapError).
      if (err && err.statusCode && err.code) {
        return reply
          .code(err.statusCode)
          .send(error(err.message || 'Validation failed', err.code))
      }
      throw err
    }

    if (!result.success) {
      const statusCode = result.code === 'STAFF_NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.data, 'Staff record updated'))
  }

  /**
   * DELETE /:id — Soft-delete (deactivate) a staff member.
   */
  async delete(request, reply) {
    const paramsParsed = shopStaffIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('shop_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.delete(paramsParsed.data.id, shopId, request.user.id)

    if (!result.success) {
      const statusCode = result.code === 'STAFF_NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(null, 'Staff member deactivated'))
  }

  /**
   * POST /:id/reset-password — Reset a staff member's password (R20 AC#9).
   *
   * Generates a fresh 12-char Temp_Password, bcrypt-hashes it (cost 12),
   * sets `users.force_password_change=true`, and bumps `session_version`
   * to invalidate every previously issued JWT for the User. Emits a
   * `staff_password_reset` audit row inside the same transaction.
   *
   * Returns the plaintext Temp_Password EXACTLY ONCE (R20 AC#9). UI
   * surfaces are responsible for displaying it to the operator and
   * never persisting it client-side.
   *
   * Authorization: the route's preHandlers gate this with
   * `requirePermission('shop_staff.reset_password')`. HQ_Users with the
   * canonical permission and SHOP_ADMIN with the same string both clear
   * the gate (HQ_ROLE_PERMISSIONS / SHOP_ROLE_DEFAULT_PERMISSIONS).
   */
  async resetPassword(request, reply) {
    const paramsParsed = shopStaffIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('shop_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.resetPassword(
      paramsParsed.data.id,
      shopId,
      {
        actorUserId: request.user?.id ?? null,
        actorRole: request.user?.shopRole ?? request.user?.shop_role ?? null,
        actorPlatformRole:
          request.user?.platform_role ?? request.user?.platformRole ?? null,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    )

    if (!result.success) {
      const statusCode = result.code === 'STAFF_NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    // R20 AC#9 — return the Temp_Password exactly once. The caller is
    // responsible for showing it to the operator without echoing it to
    // logs / analytics. No additional fields are returned to keep the
    // response surface minimal.
    return reply.code(200).send(
      success(
        { temp_password: result.temp_password },
        'Staff password reset — temp password shown exactly once'
      )
    )
  }
}
