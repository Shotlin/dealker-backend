import { CategoriesController } from './categories.controller.js'
import { CategoriesService } from './categories.service.js'
import { CategoriesRepository } from './categories.repository.js'
import {
  listCategoriesSchema,
  listCategoriesAdminSchema,
  getCategorySchema,
  getCategoryProductsSchema,
  createCategorySchema,
  updateCategorySchema,
  deleteCategorySchema,
  listBundlesSchema,
  getCategoryProductRanksSchema,
  setCategoryProductsSchema,
  toggleCategoryMembershipSchema,
  listCategoriesForProductSchema,
} from './categories.schema.js'

/**
 * Categories routes plugin
 * Prefix: /api/v1/categories
 */
export default async function categoriesRoutes(fastify) {
  const repository = new CategoriesRepository()
  const service = new CategoriesService(repository)
  const controller = new CategoriesController(service)

  /**
   * Best-effort JWT verification so customer-scoped category product lists
   * can apply shop-allocation visibility. Never rejects — these endpoints
   * remain public for anonymous browsing.
   */
  const tryAttachUser = async (request) => {
    if (typeof fastify.optionalAuth === 'function') {
      try {
        await fastify.optionalAuth(request)
      } catch {
        /* anonymous fallback */
      }
      return
    }
    try {
      await request.jwtVerify()
    } catch {
      /* anonymous fallback */
    }
  }

  // GET / — All categories (cached 30 min)
  fastify.get('/', {
    schema: listCategoriesSchema,
  }, controller.list.bind(controller))

  // GET /admin — All non-deleted categories, including inactive [ADMIN]
  fastify.get('/admin', {
    schema: listCategoriesAdminSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.listAdmin.bind(controller))

  // GET /bundles — All bundle (promo-only) categories [ADMIN]
  fastify.get('/bundles', {
    schema: listBundlesSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.listBundles.bind(controller))

  // GET /for-product/:productId — Categories a product can be cross-listed
  // into (its own primary category excluded), each flagged is_member [ADMIN]
  fastify.get('/for-product/:productId', {
    schema: listCategoriesForProductSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.listCategoriesForProduct.bind(controller))

  // GET /:id — Single category
  fastify.get('/:id', {
    schema: getCategorySchema,
  }, controller.getOne.bind(controller))

  // GET /:id/products — Products by category (paginated)
  fastify.get('/:id/products', {
    schema: getCategoryProductsSchema,
    preHandler: [tryAttachUser],
  }, controller.getProducts.bind(controller))

  // POST / — Create category [ADMIN]
  fastify.post('/', {
    schema: createCategorySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.create.bind(controller))

  // PUT /:id — Update category [ADMIN]
  fastify.put('/:id', {
    schema: updateCategorySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.update.bind(controller))

  // DELETE /:id — Delete category [ADMIN]
  fastify.delete('/:id', {
    schema: deleteCategorySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.delete.bind(controller))

  // GET /:id/products/ranks — Current product ranking for a category [ADMIN]
  fastify.get('/:id/products/ranks', {
    schema: getCategoryProductRanksSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.getProductRanks.bind(controller))

  // PUT /:id/products — Replace bundle members / standard-category ranking [ADMIN]
  fastify.put('/:id/products', {
    schema: setCategoryProductsSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.setProducts.bind(controller))

  // PUT /:id/membership — Add/remove one product from a category or bundle [ADMIN]
  fastify.put('/:id/membership', {
    schema: toggleCategoryMembershipSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.toggleCategoryMembership.bind(controller))
}
