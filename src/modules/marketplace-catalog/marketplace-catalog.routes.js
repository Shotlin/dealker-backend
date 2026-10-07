/**
 * Marketplace Catalog routes — public discovery + admin listing moderation.
 *
 * @module modules/marketplace-catalog/marketplace-catalog.routes
 */

import { MarketplaceCatalogService } from './marketplace-catalog.service.js'
import { injectSponsored } from '../ads/ads-serving.service.js'

const service = new MarketplaceCatalogService()

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
