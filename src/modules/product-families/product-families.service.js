import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'

const CACHE_PREFIX = 'bakaloo:product-families:v1'
const CACHE_TTL = 300 // 5 min

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 290)
}

export class ProductFamiliesService {
  constructor(repository) {
    this.repo = repository
  }

  async create(data) {
    const slug = data.slug || generateSlug(data.name)

    const existingSlug = await this.repo.findBySlug(slug)
    if (existingSlug) {
      return {
        success: false,
        message: 'A product family with this slug already exists',
        code: 'DUPLICATE_SLUG',
      }
    }

    const family = await this.repo.create({ ...data, slug })
    await cacheDeletePattern(`${CACHE_PREFIX}:*`)

    logger.info(
      { familyId: family.id, action: 'product_family_created' },
      'Product family created'
    )

    return { success: true, data: family }
  }

  async getById(id) {
    const cacheKey = `${CACHE_PREFIX}:${id}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const family = await this.repo.findById(id)
    if (family) {
      const productCount = await this.repo.countProductsInFamily(id)
      family.product_count = productCount
      await cacheSet(cacheKey, family, CACHE_TTL)
    }
    return family
  }

  async list(filters) {
    const cacheKey = `${CACHE_PREFIX}:list:${JSON.stringify(filters)}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const { items, total } = await this.repo.findMany(filters)
    const result = { items, total, page: filters.page, limit: filters.limit }
    await cacheSet(cacheKey, result, CACHE_TTL)
    return result
  }

  async update(id, data) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Product family not found', code: 'NOT_FOUND' }
    }

    if (data.slug && data.slug !== existing.slug) {
      const slugConflict = await this.repo.findBySlug(data.slug)
      if (slugConflict && slugConflict.id !== id) {
        return { success: false, message: 'Slug already in use', code: 'DUPLICATE_SLUG' }
      }
    }

    const updated = await this.repo.update(id, data)
    await cacheDeletePattern(`${CACHE_PREFIX}:*`)

    logger.info(
      { familyId: id, action: 'product_family_updated' },
      'Product family updated'
    )

    return { success: true, data: updated }
  }

  async deactivate(id) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Product family not found', code: 'NOT_FOUND' }
    }

    const deactivated = await this.repo.deactivate(id)
    await cacheDeletePattern(`${CACHE_PREFIX}:*`)

    logger.info(
      { familyId: id, action: 'product_family_deactivated' },
      'Product family deactivated'
    )

    return { success: true, data: deactivated }
  }

  /**
   * Admin-only: list every product belonging to a family. Used by the
   * dashboard family-detail page. Cached with the family-detail TTL so
   * the page is fast on repeat visits.
   *
   * @param {string} id
   * @returns {Promise<{family: object, options: object[]}|null>}
   */
  async listOptions(id) {
    const cacheKey = `${CACHE_PREFIX}:${id}:options`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const family = await this.repo.findById(id)
    if (!family) return null

    const options = await this.repo.findOptionsByFamilyId(id)
    const result = { family, options }
    await cacheSet(cacheKey, result, CACHE_TTL)
    return result
  }
}
