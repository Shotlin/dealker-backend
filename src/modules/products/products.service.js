import crypto from "node:crypto";
import { cacheGet, cacheSet, cacheDeletePattern } from "../../utils/cache.js";
import { generateSlug } from "../../utils/slugify.js";
import { logger } from "../../config/logger.js";
import {
  cloudinary,
  extractCloudinaryAssetInfo,
  normalizeCloudinaryDeliveryUrl,
} from "../../config/cloudinary.js";
import { AllocationService } from "../allocation/allocation.service.js";
import { AllocationRepository } from "../allocation/allocation.repository.js";
import { logAdminActivity } from "../../utils/activityLogger.js";

const CACHE_TTL_LIST = 600; // 10 min for lists
const CACHE_TTL_FEATURED = 1800; // 30 min for featured
const CACHE_TTL_DETAIL = 900; // 15 min for single product
const CACHE_TTL_SUGGESTION_CATEGORIES = 3600; // 1 hr — admin-configured pair-with category rules change rarely
// Price projection now comes exclusively from the store listing for scoped
// customers, so v4 payloads can contain an obsolete master-catalog sale.
const CACHE_VERSION = "v5";

/**
 * Hash a sorted array of UUIDs to a short stable token suitable for use
 * inside a Redis cache key. We don't need cryptographic strength here —
 * this just keeps two customers with overlapping but non-identical
 * allocations from sharing a cached payload (Requirement 14.7).
 *
 * @param {string[]} ids
 * @returns {string}
 */
function hashShopIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return "empty";
  const sorted = [...ids].sort();
  return crypto
    .createHash("sha1")
    .update(sorted.join(","))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Empty paginated result helper. Used when a customer has zero allocations
 * so we can short-circuit before hitting the repository.
 */
function emptyList(filters) {
  const page = Number(filters?.page) || 1;
  const limit = Number(filters?.limit) || 20;
  return {
    data: [],
    pagination: { page, limit, total: 0, totalPages: 0 },
  };
}

/**
 * Products service — business logic with Redis caching
 *
 * Customer-facing read paths (`list`, `search`, `getById`, `getBySlug`,
 * `getRelated`, `getPairWith`, `getFeatured`, `getPriceDrops`,
 * `getLastMinute`) accept an optional `customerContext` argument carrying
 * the requesting user's id. When present:
 *   - the service resolves the customer's allocated shop_ids via
 *     AllocationService (Redis-backed, TTL 600s)
 *   - the resolved list is forwarded to the repository which gates each
 *     query on shop_products + shops visibility predicates
 *   - cached payloads are scoped to a per-allocation hash so two
 *     customers in different areas never share results
 *
 * Admin reads pass `null` and continue to use unscoped queries. Public reads
 * always arrive with a customer allocation or signed guest store scope.
 */
export class ProductsService {
  /**
   * @param {import('./products.repository.js').ProductsRepository} repository
   * @param {object} [deps]
   * @param {AllocationService} [deps.allocationService] - Injectable for tests.
   */
  constructor(repository, deps = {}) {
    this.repo = repository;
    this.allocationService =
      deps.allocationService ||
      new AllocationService(new AllocationRepository());
  }

  // ────────────────────────────────────────────────────────
  // Allocation resolution + cache key helpers
  // ────────────────────────────────────────────────────────

  /**
   * Resolve the customer's allocated shop_ids. Returns:
   *   - null when no customer context (admin/internal → unscoped)
   *   - [] when the customer has zero allocations (caller short-circuits)
   *   - [shopId, ...] otherwise
   *
   * Errors from the allocation service are logged and treated as "no
   * allocations" so a transient Redis/DB hiccup never leaks the full
   * catalog to a customer (fail-closed for visibility, Requirement 1.5).
   *
   * @param {{ userId?: string }|null|undefined} customerContext
   * @returns {Promise<string[]|null>}
   */
  async _resolveAllocatedShopIds(customerContext) {
    if (Array.isArray(customerContext?.shopIds)) return customerContext.shopIds;
    if (!customerContext || !customerContext.userId) return null;
    try {
      // A customer has one active storefront: the primary match for their
      // current delivery address (a guest's token carries the same single
      // shop). [] is intentional when nothing is resolved: a user without a
      // resolved address must never fall back to master-catalog visibility.
      return await this.allocationService.getStorefrontShopIds(
        customerContext.userId,
      );
    } catch (err) {
      logger.error(
        {
          customerId: customerContext.userId,
          err: err.message,
          action: "products.resolve_allocations",
        },
        "Failed to resolve customer allocations; falling back to zero allocations",
      );
      return [];
    }
  }

  /**
   * Build a customer-scoped cache key fragment. Anonymous/admin callers
   * get the literal "anon" so their cached payload remains shared
   * (Requirement 14.7).
   *
   * @param {string[]|null} allocatedShopIds
   * @returns {string}
   */
  _scopeKey(allocatedShopIds) {
    if (!Array.isArray(allocatedShopIds)) return "anon";
    return `c:${hashShopIds(allocatedShopIds)}`;
  }

  /**
   * List products with filters (cached by filter combination + scope)
   *
   * @param {object} filters
   * @param {{ userId?: string }|null} [customerContext]
   */
  async list(filters, customerContext = null) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      logger.info(
        {
          customerId: customerContext?.userId,
          shopIds: [],
          action: "products.list",
        },
        "Customer has no allocated shops; returning empty product list",
      );
      return emptyList(filters);
    }

    const scope = this._scopeKey(allocatedShopIds);
    const cacheKey = `products:list:${CACHE_VERSION}:${scope}:${JSON.stringify(filters)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const result = this._normalizeProductListResult(
      await this.repo.findMany({ ...filters, allocatedShopIds }),
    );
    await cacheSet(cacheKey, result, CACHE_TTL_LIST);

    logger.info(
      {
        customerId: customerContext?.userId || null,
        shopIds: Array.isArray(allocatedShopIds)
          ? allocatedShopIds.length
          : null,
        action: "products.list",
      },
      "Products list served",
    );
    return result;
  }

  /**
   * Hybrid search — prefix FTS + ILIKE + fuzzy suggestions
   * Accepts single character queries for instant suggestions
   *
   * @param {string} q
   * @param {object} filters
   * @param {{ userId?: string }|null} [customerContext]
   */
  async search(q, filters, customerContext = null) {
    const trimmed = String(q || "").trim();

    if (!trimmed) {
      return {
        data: [],
        suggestions: [],
        pagination: {
          page: Number(filters?.page) || 1,
          limit: Number(filters?.limit) || 20,
          total: 0,
          totalPages: 0,
        },
      };
    }

    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      logger.info(
        {
          customerId: customerContext?.userId,
          shopIds: [],
          action: "products.search",
        },
        "Customer has no allocated shops; returning empty search",
      );
      return { ...emptyList(filters), suggestions: [] };
    }

    // search queries bypass cache for freshness
    try {
      return this._normalizeProductListResult(
        await this.repo.fullTextSearch(trimmed, {
          ...filters,
          allocatedShopIds,
        }),
      );
    } catch (err) {
      logger.warn(
        { err: err.message, q: trimmed, action: "products.search" },
        "Search query failed, falling back to ILIKE",
      );
      const result = this._normalizeProductListResult(
        await this.repo.findMany({
          ...filters,
          search: trimmed,
          allocatedShopIds,
        }),
      );
      return { ...result, suggestions: [] };
    }
  }

  /**
   * Featured products (cached 30 min)
   *
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getFeatured(customerContext = null, priceMode = "retail") {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return [];
    }

    const scope = this._scopeKey(allocatedShopIds);
    const cacheKey = `products:featured:${CACHE_VERSION}:${scope}:${priceMode}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const products = this._normalizeProducts(
      await this.repo.findFeatured(20, allocatedShopIds, priceMode),
    );
    await cacheSet(cacheKey, products, CACHE_TTL_FEATURED);
    return products;
  }

  /**
   * Get single product detail
   *
   * @param {string} id
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getById(
    id,
    customerContext = null,
    viewerUserId = null,
    priceMode = "retail",
  ) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return null;
    }

    const scope = this._scopeKey(allocatedShopIds);
    const cacheKey = `products:detail:${CACHE_VERSION}:${scope}:${priceMode}:${id}`;
    const cached = await cacheGet(cacheKey);
    const product = cached
      ? cached
      : this._normalizeProduct(
          await this.repo.findById(id, allocatedShopIds, priceMode),
        );
    if (!product) {
      return null;
    }
    if (!cached) {
      await cacheSet(cacheKey, product, CACHE_TTL_DETAIL);
    }

    // Attach per-user supplying-store info OUTSIDE the cache so it always
    // reflects the current address/allocation (not shared across users).
    // Uses the viewer's id directly so it works for any authenticated viewer,
    // including the demo/RIDER test account, without affecting catalog scoping.
    const resolvedViewerId = viewerUserId || customerContext?.userId || null;
    const store = await this._resolveStoreInfo(resolvedViewerId, product.id);
    return store ? { ...product, store } : product;
  }

  /**
   * Resolve the supplying-store block for a product detail response.
   * Returns null when there is no authenticated viewer.
   *
   * Shape (camelCase for the Flutter client):
   *   { shopId, shopName, shopProductId, isAvailableAtSelectedLocation,
   *     availabilityReason, selectedPincode, stockStatus }
   *
   * @param {string|null} viewerUserId
   * @param {string} productId
   * @private
   */
  async _resolveStoreInfo(viewerUserId, productId) {
    const userId = viewerUserId;
    if (!userId) return null;

    try {
      const [supplier, selectedPincode] = await Promise.all([
        this.repo.findSupplyingShopForUser(userId, productId),
        this.repo.findSelectedPincodeForUser(userId),
      ]);

      if (!supplier) {
        return {
          shopId: null,
          shopName: null,
          shopProductId: null,
          isAvailableAtSelectedLocation: false,
          availabilityReason: "PRODUCT_NOT_ASSIGNED_TO_STORE",
          selectedPincode,
          stockStatus: "unavailable",
        };
      }

      const inAllocation = supplier.in_allocation === true;
      const hasStock = Number(supplier.stock_quantity) > 0;
      const isAvailable =
        inAllocation && supplier.is_available === true && hasStock;

      let availabilityReason = "AVAILABLE";
      if (!inAllocation) {
        availabilityReason = "PRODUCT_UNAVAILABLE_AT_LOCATION";
      } else if (supplier.is_available !== true) {
        availabilityReason = "PRODUCT_UNAVAILABLE_AT_LOCATION";
      } else if (!hasStock) {
        availabilityReason = "PRODUCT_OUT_OF_STOCK";
      }

      return {
        shopId: supplier.shop_id,
        shopName: supplier.shop_name,
        shopProductId: supplier.shop_product_id,
        isAvailableAtSelectedLocation: isAvailable,
        availabilityReason,
        selectedPincode,
        stockStatus: hasStock ? "in_stock" : "out_of_stock",
      };
    } catch (err) {
      logger.warn(
        {
          productId,
          userId,
          err: err.message,
          action: "products.store_info_failed",
        },
        "Failed to resolve supplying-store info for product detail",
      );
      return null;
    }
  }

  /**
   * Get product by slug (public-facing)
   *
   * @param {string} slug
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getBySlug(
    slug,
    customerContext = null,
    viewerUserId = null,
    priceMode = "retail",
  ) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return null;
    }

    const scope = this._scopeKey(allocatedShopIds);
    const cacheKey = `products:slug:${CACHE_VERSION}:${scope}:${priceMode}:${slug}`;
    const cached = await cacheGet(cacheKey);
    const product = cached
      ? cached
      : this._normalizeProduct(
          await this.repo.findBySlug(slug, allocatedShopIds, priceMode),
        );
    if (!product) {
      return null;
    }
    if (!cached) {
      await cacheSet(cacheKey, product, CACHE_TTL_DETAIL);
    }

    const resolvedViewerId = viewerUserId || customerContext?.userId || null;
    const store = await this._resolveStoreInfo(resolvedViewerId, product.id);
    return store ? { ...product, store } : product;
  }

  /**
   * Get product by ID or slug (auto-detect)
   *
   * @param {string} identifier
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getByIdOrSlug(
    identifier,
    customerContext = null,
    viewerUserId = null,
    priceMode = "retail",
  ) {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identifier,
      );
    return isUUID
      ? this.getById(identifier, customerContext, viewerUserId, priceMode)
      : this.getBySlug(identifier, customerContext, viewerUserId, priceMode);
  }

  /**
   * Get related products (same category)
   *
   * @param {string} id
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getRelated(id, customerContext = null) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return [];
    }

    // Look up the master-catalog row directly (admin scope) so we can read
    // its category_id; visibility is enforced separately by findRelated.
    const product = await this.repo.findById(id);
    if (!product) return null;

    return this._normalizeProducts(
      await this.repo.findRelated(
        id,
        product.category_id,
        10,
        allocatedShopIds,
      ),
    );
  }

  async getPairWith(productId, categoryId, limit = 10, customerContext = null) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return [];
    }

    // Admin-configured "which categories pair with this one" (migration 080
    // category_suggestion_rules). Cached per-category — this list changes
    // rarely and is shared by every product in the category, unlike the
    // final ranked result below which stays live (stock/price must not go
    // stale). Empty array means "no rule configured" and findPairWith()
    // falls back to its original any-other-category behavior for it.
    // Key format is shared with product-suggestions.service.js, which
    // deletes this exact key when an admin saves a rule change.
    const suggestionCacheKey = `products:pairwith-categories:v1:${categoryId}`;
    let targetCategoryIds = await cacheGet(suggestionCacheKey);
    if (targetCategoryIds == null) {
      targetCategoryIds =
        await this.repo.getSuggestionTargetCategoryIds(categoryId);
      await cacheSet(
        suggestionCacheKey,
        targetCategoryIds,
        CACHE_TTL_SUGGESTION_CATEGORIES,
      );
    }

    return this._normalizeProducts(
      await this.repo.findPairWith(
        productId,
        categoryId,
        limit,
        allocatedShopIds,
        targetCategoryIds,
      ),
    );
  }

  /**
   * "Quick Add" recommendations for the cart screen — one ranked list
   * blending three pools so the rail stays full and relevant regardless of
   * how varied the cart is:
   *   - ~60% popular items from the SAME categories already in the cart
   *   - ~30% popular items from categories admin-configured to pair with
   *     those (migration 080 category_suggestion_rules — same cache the
   *     product-detail "Pair it with" rail uses)
   *   - the remainder: a random sample from the overall popular pool
   *
   * Buckets are filled in that priority order and each one's shortfall
   * rolls into the random pool at the end, so the list still reaches
   * `limit` even for a niche cart with few same/related-category
   * candidates — it just leans more "random popular" in that case.
   *
   * @param {string[]} cartCategoryIds - Distinct category ids present in the cart.
   * @param {string[]} excludeProductIds - Product ids already in the cart.
   * @param {number} [limit=12]
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getQuickAdd(
    cartCategoryIds,
    excludeProductIds,
    limit = 12,
    customerContext = null,
  ) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);
    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return [];
    }

    const categoryIds = [...new Set((cartCategoryIds || []).filter(Boolean))];
    const excluded = new Set((excludeProductIds || []).filter(Boolean));
    const picked = [];

    if (categoryIds.length > 0) {
      const sameCategoryLimit = Math.round(limit * 0.6);
      // The same-category product query and the related-category-id lookup
      // (below) read only the inputs already known at this point — neither
      // depends on the other's result — so they run concurrently instead of
      // one DB round trip after another; `excluded`/`picked` are still
      // updated from `sameCategory` strictly before the related-category
      // fetch runs, preserving the exact same dedup/ordering behavior.
      const [sameCategory, relatedCategoryIdLists] = await Promise.all([
        this.repo.findPopularByCategories(
          categoryIds,
          [...excluded],
          sameCategoryLimit,
          allocatedShopIds,
        ),
        Promise.all(
          categoryIds.map((id) => this._getCachedSuggestionCategoryIds(id)),
        ),
      ]);
      for (const product of sameCategory) {
        picked.push(product);
        excluded.add(product.id);
      }

      const relatedCategoryIds = [
        ...new Set(relatedCategoryIdLists.flat()),
      ].filter((id) => !categoryIds.includes(id));

      if (relatedCategoryIds.length > 0) {
        const relatedLimit = Math.round(limit * 0.3);
        const relatedCategory = await this.repo.findPopularByCategories(
          relatedCategoryIds,
          [...excluded],
          relatedLimit,
          allocatedShopIds,
        );
        for (const product of relatedCategory) {
          picked.push(product);
          excluded.add(product.id);
        }
      }
    }

    const stillNeeded = limit - picked.length;
    if (stillNeeded > 0) {
      const randomPicks = await this.repo.findPopularRandom(
        [...excluded],
        stillNeeded,
        allocatedShopIds,
      );
      picked.push(...randomPicks);
    }

    return this._normalizeProducts(picked.slice(0, limit));
  }

  /**
   * Cached admin-configured "pairs with" target category ids for a single
   * category (migration 080 category_suggestion_rules). Same cache key/TTL
   * as getPairWith() above since both read the same admin-configured rule
   * and product-suggestions.service.js invalidates this one key on save.
   */
  async _getCachedSuggestionCategoryIds(categoryId) {
    const cacheKey = `products:pairwith-categories:v1:${categoryId}`;
    let ids = await cacheGet(cacheKey);
    if (ids == null) {
      ids = await this.repo.getSuggestionTargetCategoryIds(categoryId);
      await cacheSet(cacheKey, ids, CACHE_TTL_SUGGESTION_CATEGORIES);
    }
    return ids;
  }

  /**
   * Get all purchasable options for a product's family (cached 15 min)
   *
   * @param {string} productId
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getProductOptions(productId, customerContext = null) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return null;
    }

    const scope = this._scopeKey(allocatedShopIds);
    const cacheKey = `products:options:${CACHE_VERSION}:${scope}:${productId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const result = await this.repo.findFamilyOptions(
      productId,
      allocatedShopIds,
    );
    if (!result) return null;

    // Normalize image URLs on options
    const normalized = {
      family: result.family,
      options: this._normalizeProducts(result.options),
    };

    await cacheSet(cacheKey, normalized, CACHE_TTL_DETAIL);
    return normalized;
  }

  async getPriceDrops(
    limit = 10,
    customerContext = null,
    priceMode = "retail",
  ) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return [];
    }

    return this._normalizeProducts(
      await this.repo.getPriceDrops(limit, allocatedShopIds, priceMode),
    );
  }

  async getLastMinute(
    limit = 10,
    customerContext = null,
    priceMode = "retail",
  ) {
    const allocatedShopIds =
      await this._resolveAllocatedShopIds(customerContext);

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return [];
    }

    return this._normalizeProducts(
      await this.repo.getLastMinute(limit, allocatedShopIds, priceMode),
    );
  }

  /**
   * Create product [ADMIN]
   */
  async create(data, adminId = null, ip = null) {
    const productData = {
      ...data,
      slug: generateSlug(data.name),
    };

    const product = await this.repo.create(productData);

    // Invalidate list/featured caches
    await cacheDeletePattern("products:list:*");
    await cacheDeletePattern("products:featured*");
    // The categories list embeds a per-category product_count, which
    // goes stale the moment a product is added to a category.
    await cacheDeletePattern("categories:*");
    if (data.productFamilyId) {
      await cacheDeletePattern("bakaloo:product-families:v1:*");
    }
    logger.info(
      { productId: product.id, action: "products.create" },
      "Product created",
    );
    // Previously unaudited — single-product edits never appeared in the
    // Activity Log at all, unlike the sibling admin/products module's
    // bulkUpdate()/duplicate(), which is why a price mix-up on a single
    // product was untraceable without a direct DB investigation.
    logAdminActivity(
      adminId,
      "CREATE_PRODUCT",
      "product",
      product.id,
      null,
      product,
      ip,
    );

    return { success: true, product: this._normalizeProduct(product) };
  }

  /**
   * Update product [ADMIN]
   */
  async update(id, data, adminId = null, ip = null) {
    const existing = await this.repo.findById(id);
    if (!existing) return { success: false, message: "Product not found" };

    const updateData = { ...data };

    // Re-generate slug if name changed
    if (updateData.name && updateData.name !== existing.name) {
      updateData.slug = generateSlug(updateData.name);
    }

    const product = await this.repo.update(id, updateData);

    // Best-effort Cloudinary cleanup — only after the DB swap above has
    // already succeeded (mirrors theme-tabs.service.js#updateIcon), so a
    // failed delete never leaves the record pointing at a missing asset,
    // and never fails the update that already landed.
    if (
      updateData.images !== undefined ||
      updateData.thumbnailUrl !== undefined
    ) {
      await this._deleteOrphanedImages(existing, updateData);
    }

    await cacheDeletePattern("products:*");
    // category_id or is_active may have changed — the categories
    // list's cached product_count needs to reflect that.
    await cacheDeletePattern("categories:*");
    // product_family_id, option_label, etc. may have changed — the family
    // detail page's cached options list and product_count need to reflect
    // that immediately rather than waiting out their TTL.
    if (
      updateData.productFamilyId !== undefined ||
      existing.product_family_id
    ) {
      await cacheDeletePattern("bakaloo:product-families:v1:*");
    }
    logger.info(
      { productId: id, action: "products.update" },
      "Product updated",
    );
    logAdminActivity(
      adminId,
      "UPDATE_PRODUCT",
      "product",
      id,
      existing,
      product,
      ip,
    );

    return { success: true, product: this._normalizeProduct(product) };
  }

  /**
   * Update stock [ADMIN]
   */
  async updateStock(id, stock, adminId = null, ip = null) {
    const existing = await this.repo.findById(id);
    if (!existing) return { success: false, message: "Product not found" };

    const product = await this.repo.updateStock(id, stock);

    await cacheDeletePattern(`products:detail:*:${id}`);
    await cacheDeletePattern("products:list:*");
    logAdminActivity(
      adminId,
      "UPDATE_PRODUCT_STOCK",
      "product",
      id,
      { stock_quantity: existing.stock_quantity },
      { stock_quantity: stock },
      ip,
    );

    return { success: true, product };
  }

  /**
   * Delete (deactivate) product [ADMIN]
   */
  async delete(id, adminId = null, ip = null) {
    const existing = await this.repo.findById(id);
    if (!existing) return { success: false, message: "Product not found" };

    await this.repo.delete(id);

    await cacheDeletePattern("products:*");
    await cacheDeletePattern("categories:*");
    if (existing.product_family_id) {
      await cacheDeletePattern("bakaloo:product-families:v1:*");
    }
    logger.info(
      { productId: id, action: "products.delete" },
      "Product deleted",
    );
    logAdminActivity(
      adminId,
      "DELETE_PRODUCT",
      "product",
      id,
      existing,
      null,
      ip,
    );

    return { success: true };
  }

  /**
   * Delete any Cloudinary image that was on the product before this update
   * but is no longer referenced by it (dropped from `images[]`, or replaced
   * as `thumbnail_url`). Never throws — a delete failure only logs a
   * warning, matching theme-tabs.service.js#updateIcon's cleanup contract.
   *
   * @param {object} existing - the pre-update product row
   * @param {object} updateData - the validated update payload (camelCase)
   */
  async _deleteOrphanedImages(existing, updateData) {
    const oldUrls = [
      ...(Array.isArray(existing.images) ? existing.images : []),
      existing.thumbnail_url,
    ].filter(Boolean);

    const stillInUse = new Set(
      [
        ...(updateData.images !== undefined
          ? updateData.images || []
          : Array.isArray(existing.images)
            ? existing.images
            : []),
        updateData.thumbnailUrl !== undefined
          ? updateData.thumbnailUrl
          : existing.thumbnail_url,
      ].filter(Boolean),
    );

    const orphaned = oldUrls.filter((url) => !stillInUse.has(url));
    if (orphaned.length === 0) return;

    for (const url of orphaned) {
      const asset = extractCloudinaryAssetInfo(url);
      if (!asset?.publicId) continue;
      try {
        await cloudinary.uploader.destroy(asset.publicId);
      } catch (err) {
        logger.warn(
          { err, publicId: asset.publicId, productId: existing.id },
          "Failed to delete orphaned product image from Cloudinary",
        );
      }
    }
  }

  _normalizeProductListResult(result) {
    if (!result) return result;

    return {
      ...result,
      data: this._normalizeProducts(result.data),
      suggestions: this._normalizeProducts(result.suggestions),
    };
  }

  _normalizeProducts(products = []) {
    return products.map((product) => this._normalizeProduct(product));
  }

  _normalizeProduct(product) {
    if (!product) return product;

    return {
      ...product,
      thumbnail_url: normalizeCloudinaryDeliveryUrl(
        product.thumbnail_url,
        "default",
      ),
      images: Array.isArray(product.images)
        ? product.images.map((image) =>
            normalizeCloudinaryDeliveryUrl(image, "default"),
          )
        : product.images,
    };
  }
}
