/**
 * Vendor growth: how many customers follow the vendor's shop(s), and the shop profile photo.
 * Mounted at /api/v1/vendor/growth.
 *
 * @module modules/vendor-growth/vendor-growth.routes
 */

import { query } from '../../config/database.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

const httpUrl = /^https?:\/\/[^\s]{4,500}$/i

export const vendorGrowthRoutes = async function vendorGrowthRoutes(fastify) {
  const pre = [fastify.authenticate, requireVendorScope({ requireVendor: true })]

  fastify.get('/', {
    preHandler: pre,
    handler: async (request) => {
      const { rows } = await query(
        `SELECT COUNT(f.user_id)::int AS total,
                COUNT(f.user_id) FILTER (WHERE f.created_at > NOW() - INTERVAL '7 days')::int AS week,
                COUNT(f.user_id) FILTER (WHERE f.created_at > NOW() - INTERVAL '30 days')::int AS month
           FROM shops s LEFT JOIN shop_follows f ON f.shop_id = s.id
          WHERE s.vendor_id = $1 AND s.deleted_at IS NULL`, [request.vendorId])
      const shop = (await query(
        `SELECT name, logo_url FROM shops WHERE vendor_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
        [request.vendorId])).rows[0]
      return {
        success: true,
        data: {
          followers: rows[0].total, followersThisWeek: rows[0].week, followersThisMonth: rows[0].month,
          shopName: shop?.name || null, logoUrl: shop?.logo_url || null,
        },
      }
    },
  })

  /** Set the shop profile photo to an already-uploaded image (POST /uploads/local?kind=shop). body: { url } */
  fastify.put('/logo', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['url'], properties: { url: { type: 'string', maxLength: 500 } } } },
    handler: async (request, reply) => {
      const url = String(request.body.url || '').trim()
      if (!httpUrl.test(url)) return reply.code(400).send({ success: false, code: 'VALIDATION', message: 'Invalid image link' })
      await query(`UPDATE shops SET logo_url = $2, updated_at = NOW() WHERE vendor_id = $1 AND deleted_at IS NULL`, [request.vendorId, url])
      return { success: true, data: { logoUrl: url } }
    },
  })
}
