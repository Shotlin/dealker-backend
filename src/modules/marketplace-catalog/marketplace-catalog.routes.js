/**
 * Marketplace Catalog routes — public discovery + admin listing moderation.
 *
 * @module modules/marketplace-catalog/marketplace-catalog.routes
 */

import { MarketplaceCatalogService } from './marketplace-catalog.service.js'
import { injectSponsored } from '../ads/ads-serving.service.js'
import { ShopDirectoryService } from './shop-directory.service.js'
import { distancesFor } from '../distance/distance.service.js'

const service = new MarketplaceCatalogService()
const shopDirectory = new ShopDirectoryService()

/** Public routes — mounted at /api/v1/discovery */
export const publicDiscoveryRoutes = async function discoveryRoutes(fastify) {
  fastify.get('/search', {
    // Identify the shopper when a token is sent (ad impressions carry the user for click de-duplication);
    // anonymous browsing stays fully allowed.
    preHandler: async (request) => {
      try { await request.jwtVerify() } catch { /* anonymous */ }
    },
    handler: async (request) => {
      const {
        q = '', pincode = '', lat, lng, categoryId, brand,
        minPrice, maxPrice, minRating, condition, owner, inStock, sort, page = 1, limit = 24,
      } = request.query || {}
      const filtered = [brand, minPrice, maxPrice, minRating, condition, owner].some((v) => v != null && v !== '')
      const result = await service.search({
        q: String(q || ''), pincode: String(pincode || ''),
        lat: lat != null ? Number(lat) : null,
        lng: lng != null ? Number(lng) : null,
        categoryId: categoryId || null, brand: brand || null,
        minPrice: minPrice != null ? Number(minPrice) : null,
        maxPrice: maxPrice != null ? Number(maxPrice) : null,
        minRating: minRating != null ? Number(minRating) : null,
        condition: condition || null, owner: owner || null,
        inStockOnly: inStock !== 'false',
        sort: String(sort || 'relevance'),
        page: Number(page), limit: Math.min(60, Number(limit)),
      })
      // Sponsored placements ride on relevance-sorted, unfiltered results only (a price/brand filter
      // would otherwise be violated by a paid slot). Ads never break search: failures return `result`.
      if (filtered || (sort && sort !== 'relevance') || inStock === 'false') return result
      return injectSponsored(result, {
        q: String(q || ''), categoryId: categoryId || null, pincode: String(pincode || ''),
        userId: request.user?.id || null, page: Math.max(1, Number(page) || 1),
      })
    },
  })

  // Vendor shops (Home "Shops (Nearby N)" + All shops). Anonymous allowed; a token adds is_following.
  fastify.get('/shops', {
    preHandler: async (request) => {
      try { await request.jwtVerify() } catch { /* anonymous */ }
    },
    handler: async (request) => {
      const { lat, lng, limit = 12, addressId } = request.query || {}
      return shopDirectory.list({ lat, lng, limit, userId: request.user?.id || null, addressId: addressId || null })
    },
  })

  const optionalAuth = async (request) => {
    try { await request.jwtVerify() } catch { /* anonymous */ }
  }

  fastify.get('/shops/:id', {
    preHandler: optionalAuth,
    handler: async (request, reply) => {
      const { lat, lng, addressId } = request.query || {}
      const result = await shopDirectory.profile(request.params.id, request.user?.id || null, { lat, lng, addressId: addressId || null })
      if (!result) return reply.code(404).send({ success: false, message: 'Shop not found' })
      return result
    },
  })

  // Saved road distance from the caller's pin to many shops (product boxes batch their shop ids here).
  fastify.get('/distances', {
    preHandler: optionalAuth,
    handler: async (request) => {
      const { lat, lng, shopIds = '', addressId } = request.query || {}
      const ids = String(shopIds).split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x))
      const data = await distancesFor({ lat: Number(lat), lng: Number(lng) }, ids, { userId: request.user?.id || null, addressId: addressId || null })
      return { success: true, data }
    },
  })

  fastify.get('/shops/:id/products', {
    handler: async (request) => {
      const { categoryId, deals, sort, page, limit } = request.query || {}
      return shopDirectory.products(request.params.id, {
        categoryId: categoryId || null,
        deals: deals === '1' || deals === 'true',
        sort, page, limit,
      })
    },
  })

  fastify.post('/shops/:id/follow', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const state = await shopDirectory.follow(request.user.id, request.params.id)
      if (!state) return reply.code(404).send({ success: false, message: 'Shop not found' })
      return { success: true, data: state }
    },
  })

  fastify.delete('/shops/:id/follow', {
    preHandler: [fastify.authenticate],
    handler: async (request) => ({
      success: true,
      data: await shopDirectory.unfollow(request.user.id, request.params.id),
    }),
  })

  fastify.get('/home', {
    handler: async (request) => {
      const { pincode = '', lat, lng, limit = 12 } = request.query || {}
      return service.homeFeed({
        pincode: String(pincode || ''),
        lat: lat != null ? Number(lat) : null,
        lng: lng != null ? Number(lng) : null,
        limit: Math.min(30, Number(limit)),
      })
    },
  })
}

/** Admin routes — mounted at /api/v1/admin/seller-listings */
export const adminSellerListingsRoutes = async function sellerListingsAdminRoutes(fastify) {
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requirePermission('marketplace.listings.view')],
    handler: async (request) => {
      const { vendorId, shopId, status, approvalStatus, search, page = 1, limit = 20 } = request.query || {}
      return service.adminListings({
        vendorId: vendorId || null, shopId: shopId || null,
        status: String(status || ''), approvalStatus: String(approvalStatus || ''),
        search: String(search || ''), page: Number(page), limit: Math.min(100, Number(limit)),
      })
    },
  })

  fastify.patch('/:id/moderate', {
    preHandler: [fastify.authenticate, fastify.requirePermission('marketplace.listings.moderate')],
    handler: async (request) => {
      const { listingStatus, approvalStatus, reason } = request.body || {}
      const row = await service.moderateListing(request.params.id, {
        listingStatus: listingStatus || null,
        approvalStatus: approvalStatus || null,
        reason: reason || null,
        actorId: request.user?.id,
      })
      return { success: true, data: row }
    },
  })
}
