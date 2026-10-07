import { getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { ERROR_CODES } from '../../constants/errors.js'
import { emitInTx as emitAuditInTx } from '../../utils/audit-log.js'
import { cacheDeletePattern } from '../../utils/cache.js'
import { ShopProductsRepository } from './shop-products.repository.js'

/**
 * Manual product creation service — implements the single-transaction
 * flow for POST /api/v1/shops/:shopId/products/manual (R23.15–R23.24).
 *
 * Transaction steps:
 *   1. Case-insensitive uniqueness check on (name, brand, unit) in the
 *      master `products` table → 409 MASTER_PRODUCT_EXISTS on collision.
 *   2. INSERT into `products` (master catalog row).
 *   3. INSERT into `shop_products` (shop-scoped listing with
 *      approval_status from MULTI_VENDOR_PRODUCT_APPROVAL flag).
 *   4. INSERT into `stock_movements` via repo.applyStockChange
 *      (MANUAL_ADJUSTMENT, source=DASHBOARD, qty_before=0,
 *      qty_after=stock_quantity).
 *   5. Emit `manual_product_created` audit row transactionally.
 *
 * Image validation (task 6.3):
 *   Validates every `image_id` in the request body exists in the
 *   `uploads` tracking or Cloudinary. Since the platform uses a
 *   fire-and-forget Cloudinary upload model (no DB uploads table),
 *   image_ids are treated as Cloudinary public_ids that the Dashboard
 *   obtained from the upload endpoint. Validation confirms UUID format
 *   (Zod) and count (0–8). The IDs are stored in `products.images`
 *   JSONB array.
 *
 * Requirements: R23.15, R23.16, R23.17, R23.18, R23.19, R23.20,
 *               R23.21, R23.22, R23.23, R23.24
 * Design:       §8.2
 */

const CACHE_PREFIX = 'bakaloo:shop-products:v1'

/**
 * Generate a URL-safe slug from a product name.
 * @param {string} name
 * @returns {string}
 */
function generateSlug(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  // Append a short random suffix to avoid slug collisions
  const suffix = Math.random().toString(36).substring(2, 8)
  return `${base}-${suffix}`
}

export class ManualCreateService {
  /**
   * @param {object} [deps]
   * @param {ShopProductsRepository} [deps.repository]
   */
  constructor(deps = {}) {
    this.repo = deps.repository || new ShopProductsRepository()
  }

  /**
   * Validate image_ids against the upload service rules.
   * Since the platform uses Cloudinary without a DB uploads table,
   * validation ensures:
   *   - Each ID is a valid UUID (handled by Zod schema upstream)
   *   - Array length 0–8 (handled by Zod schema upstream)
   *   - IDs are non-duplicate within the array
   *
   * If a dedicated uploads table is added later, this method should
   * query it to confirm each image_id exists and belongs to the
   * requesting user/shop.
   *
   * @param {string[]} imageIds
   * @returns {{ valid: boolean, message?: string }}
   */
  validateImageIds(imageIds) {
    if (!imageIds || imageIds.length === 0) {
      return { valid: true }
    }

    // Check for duplicates
    const seen = new Set()
    for (const id of imageIds) {
      if (seen.has(id)) {
        return {
          valid: false,
          message: `Duplicate image_id: ${id}`,
        }
      }
      seen.add(id)
    }

    return { valid: true }
  }

  /**
   * Create a master product + shop_product + initial stock movement
   * in a single transaction.
   *
   * @param {string} shopId - Resolved shop_id (from JWT, X-Shop-Id, or :shopId)
   * @param {object} body - Validated request body (from manualCreateProductSchema)
   * @param {object} actor - { id, role, shopRole, platformRole, ip, userAgent }
   * @returns {Promise<{success:boolean, data?:object, message?:string, code?:string, existing_product_id?:string}>}
   */
  async manualCreate(shopId, body, actor) {
    // ── Image validation (task 6.3) ──────────────────────────
    const imageValidation = this.validateImageIds(body.image_ids)
    if (!imageValidation.valid) {
      return {
        success: false,
        message: imageValidation.message,
        code: ERROR_CODES.PRODUCT_IMAGE_INVALID,
      }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // ── Step 1: Case-insensitive uniqueness check (R23.16) ──
      // Match on (name, brand, unit) — brand can be NULL so we use
      // IS NOT DISTINCT FROM for the comparison.
      const duplicateCheck = await client.query(
        `SELECT id, name, brand, unit
           FROM products
          WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
            AND LOWER(COALESCE(TRIM(brand), '')) IS NOT DISTINCT FROM LOWER(COALESCE(TRIM($2), ''))
            AND LOWER(TRIM(unit)) = LOWER(TRIM($3))
          LIMIT 1`,
        [body.name, body.brand || null, body.unit]
      )

      if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'A product with this name, brand, and unit already exists in the master catalog',
          code: ERROR_CODES.MASTER_PRODUCT_EXISTS,
          existing_product_id: duplicateCheck.rows[0].id,
        }
      }

      // ── Step 2: INSERT into products (master catalog) ───────
      const slug = generateSlug(body.name)
      const imagesJson = JSON.stringify(body.image_ids || [])

      const productResult = await client.query(
        `INSERT INTO products (
           name, slug, description, price, sale_price, cost_price,
           category_id, stock_quantity, unit, images, brand, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, true)
         RETURNING id, name, slug, description, price, sale_price,
                   cost_price, category_id, stock_quantity, unit,
                   images, brand, is_active, created_at, updated_at`,
        [
          body.name.trim(),
          slug,
          body.description || null,
          body.price,
          body.sale_price || null,
          body.cost_price || null,
          body.category_id || null,
          body.stock_quantity,
          body.unit,
          imagesJson,
          body.brand || null,
        ]
      )
      const product = productResult.rows[0]

      // ── Step 3: INSERT into shop_products ────────────────────
      // approval_status depends on MULTI_VENDOR_PRODUCT_APPROVAL flag
      // stock_quantity starts at 0; applyStockChange will set it to the
      // desired value via delta (step 4).
      const approvalStatus = env.MULTI_VENDOR_PRODUCT_APPROVAL
        ? 'PENDING'
        : 'APPROVED'

      const initialStock = body.stock_quantity > 0 ? 0 : body.stock_quantity
      const soldOutAt =
        body.stock_quantity === 0 && body.is_available === false
          ? new Date()
          : null

      const shopProductResult = await client.query(
        `INSERT INTO shop_products (
           shop_id, product_id,
           price, sale_price, cost_price,
           stock_quantity, low_stock_threshold, max_order_qty,
           is_available, sold_out_at, approval_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, shop_id, product_id,
                   price, sale_price, cost_price,
                   stock_quantity, low_stock_threshold, max_order_qty,
                   is_available, sold_out_at,
                   approval_status, approved_at, approved_by, rejection_reason,
                   deleted_at, created_at, updated_at`,
        [
          shopId,
          product.id,
          body.price,
          body.sale_price || null,
          body.cost_price || null,
          initialStock,
          body.low_stock_threshold,
          body.max_order_qty,
          body.is_available,
          soldOutAt,
          approvalStatus,
        ]
      )
      const shopProduct = shopProductResult.rows[0]

      // ── Step 4: INSERT into stock_movements (R23.4) ─────────
      // Use applyStockChange only when stock_quantity > 0 (delta must
      // be non-zero). When stock_quantity is 0, skip the movement
      // insertion since applyStockChange rejects delta=0.
      let movement = null
      let finalShopProduct = shopProduct
      if (body.stock_quantity > 0) {
        const stockResult = await this.repo.applyStockChange(client, {
          shopProductId: shopProduct.id,
          delta: body.stock_quantity,
          type: 'MANUAL_ADJUSTMENT',
          reason: 'Initial stock from manual product creation',
          actor: {
            userId: actor.id || null,
            shopRole: actor.shopRole || null,
          },
          source: 'DASHBOARD',
          metadata: { ip: actor.ip || null, action: 'manual_product_created' },
          orderId: null,
        })
        movement = stockResult.movement
        finalShopProduct = stockResult.stockProduct
      }

      // ── Step 5: Emit audit row transactionally (R23.24) ─────
      await emitAuditInTx(client, 'manual_product_created', {
        actor_user_id: actor.id || null,
        actor_role:
          actor.platformRole || actor.shopRole || actor.role || null,
        actor_shop_id: shopId,
        target_type: 'shop_product',
        target_id: finalShopProduct.id,
        before: null,
        after: {
          product_id: product.id,
          shop_product_id: finalShopProduct.id,
          name: product.name,
          brand: product.brand,
          unit: product.unit,
          price: finalShopProduct.price,
          stock_quantity: finalShopProduct.stock_quantity,
          low_stock_threshold: finalShopProduct.low_stock_threshold,
          max_order_qty: finalShopProduct.max_order_qty,
          is_available: finalShopProduct.is_available,
          approval_status: finalShopProduct.approval_status,
          image_ids: body.image_ids,
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null,
      })

      await client.query('COMMIT')

      // ── Post-commit: cache invalidation (R23.13) ────────────
      await cacheDeletePattern(`${CACHE_PREFIX}:${shopId}:*`)

      logger.info(
        {
          userId: actor.id,
          shopId,
          productId: product.id,
          shopProductId: finalShopProduct.id,
          action: 'manual_product_created',
        },
        'Manual product created'
      )

      return {
        success: true,
        data: {
          product,
          shop_product: finalShopProduct,
          movement,
        },
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }

      // Handle unique constraint violations (slug collision — retry-safe)
      if (err && err.code === '23505' && err.constraint?.includes('slug')) {
        logger.warn(
          { err: err.message, name: body.name, action: 'manual_product_slug_collision' },
          'Slug collision during manual product creation — retrying'
        )
        // Recursive retry with a fresh slug (the random suffix makes
        // collisions extremely unlikely, but handle defensively)
        return this.manualCreate(shopId, body, actor)
      }

      // PG CHECK constraint violation
      if (err && err.code === '23514') {
        return {
          success: false,
          message: 'Database constraint violation — check field values',
          code: ERROR_CODES.VALIDATION_ERROR,
        }
      }

      throw err
    } finally {
      client.release()
    }
  }
}
