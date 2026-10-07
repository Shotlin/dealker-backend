import { AllocationController } from './allocation.controller.js'
import { AllocationService } from './allocation.service.js'
import { AllocationRepository } from './allocation.repository.js'
import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'
import { logger } from '../../config/logger.js'

/**
 * Allocation routes plugin
 * Prefix: /api/v1/allocation
 *
 * Endpoints:
 *   - GET  /my-shops   — Any authenticated user (customer view)
 *   - POST /recompute  — ADMIN role OR self (user_id matches JWT)
 *                        Rate-limited to 10/min to prevent recompute storms.
 */
export default async function allocationRoutes(fastify) {
  const repository = new AllocationRepository()
  const service = new AllocationService(repository)
  const controller = new AllocationController(service)

  // ── GET /my-shops ───────────────────────────────────────
  fastify.get(
    '/my-shops',
    {
      schema: {
        tags: ['Allocation'],
        summary: 'List shops allocated to the current user',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  shops: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        shop_id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        distance_km: { type: ['number', 'null'] },
                        matched_pincode: { type: ['string', 'null'] },
                        is_primary: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.myShops.bind(controller)
  )

  // ── POST /recompute ─────────────────────────────────────
  // Caller must be ADMIN or pass own user_id (controller enforces).
  fastify.post(
    '/recompute',
    {
      schema: {
        tags: ['Allocation'],
        summary: 'Recompute allocations for a user (ADMIN or self)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            user_id: { type: 'string', format: 'uuid' },
            address: {
              type: 'object',
              required: ['lat', 'lng', 'pincode'],
              properties: {
                lat: { type: 'number', minimum: -90, maximum: 90 },
                lng: { type: 'number', minimum: -180, maximum: 180 },
                pincode: { type: 'string', minLength: 1, maxLength: 10 },
              },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    controller.recompute.bind(controller)
  )

  // ── POST /auto-assign ───────────────────────────────────
  // Called by Flutter immediately after login/session restore if the user
  // has no allocations yet but does have a saved default address.
  // Reads the user's default address from the DB and runs recompute.
  // Returns { shopCount, shops } on success; { code: 'NO_DEFAULT_ADDRESS' }
  // if no address exists yet (app should then prompt for address entry).
  //
  // Rate-limited to 10 req/min to prevent abuse.
  fastify.post(
    '/auto-assign',
    {
      schema: {
        tags: ['Allocation'],
        summary: 'Auto-assign shops using saved default address (call on login)',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  shopCount: { type: 'number' },
                  shops: { type: 'array' },
                  alreadyAllocated: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const userId = request.user?.id
      if (!userId) {
        return reply.code(401).send(error('Unauthorized', 'UNAUTHORIZED'))
      }

      // Check if user already has allocations — avoid redundant recompute.
      const existing = await service.getForUser(userId)
      if (existing?.shops?.length > 0) {
        return reply.code(200).send(
          success(
            { shopCount: existing.shops.length, shops: existing.shops, alreadyAllocated: true },
            'Allocation already exists'
          )
        )
      }

      // Look up the user's default address.
      const { rows: addressRows } = await query(
        `SELECT lat, lng, pincode
           FROM addresses
          WHERE user_id = $1
            AND is_default = true
            AND deleted_at IS NULL
            AND lat IS NOT NULL
            AND lng IS NOT NULL
            AND pincode IS NOT NULL
          LIMIT 1`,
        [userId]
      )

      if (addressRows.length === 0) {
        // No address yet — Flutter should prompt for location.
        return reply.code(200).send(
          success(
            { shopCount: 0, shops: [], alreadyAllocated: false },
            'No default address found — please add a delivery address'
          )
        )
      }

      const addr = addressRows[0]
      const result = await service.computeAndUpsertForUser(userId, {
        lat: Number(addr.lat),
        lng: Number(addr.lng),
        pincode: String(addr.pincode),
      })

      if (!result.success) {
        logger.warn(
          { userId, code: result.code, action: 'auto_assign.recompute_failed' },
          'Auto-assign allocation recompute failed'
        )
        return reply.code(200).send(
          success(
            { shopCount: 0, shops: [], alreadyAllocated: false },
            result.message || 'Could not compute allocation'
          )
        )
      }

      const shopCount = result.data?.shops?.length ?? 0
      logger.info(
        { userId, shopCount, action: 'auto_assign.success' },
        'Auto-assign allocation completed'
      )

      return reply.code(200).send(
        success(
          { shopCount, shops: result.data?.shops ?? [], alreadyAllocated: false },
          shopCount > 0
            ? `Allocated to ${shopCount} shop(s)`
            : 'No shops available for your location — please check your delivery area'
        )
      )
    }
  )
}
