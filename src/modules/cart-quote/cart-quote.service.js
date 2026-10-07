/**
 * Cart, Loyalty & Quote Service — Business Logic Engine
 * Source of truth: Blueprint §06.6, Phase 7
 *
 * @module modules/cart-quote/cart-quote.service
 */

import crypto from 'node:crypto'
import { logger } from '../../config/logger.js'

export class CartQuoteService {
  /**
   * @param {import('./cart-quote.repository.js').CartQuoteRepository} repository
   */
  constructor(repository) {
    this.repository = repository
  }

  // ─── CART SERVICES ──────────────────────────────────
  async getCart(customerId) {
    return this.repository.getCartWithItems(customerId)
  }

  async addItem(customerId, payload) {
    const { product_id, quantity } = payload
    const product = await this.repository.findProductById(product_id)

    if (!product || product.is_active === false || product.status === 'INACTIVE') {
      const err = new Error('Product is unavailable or out of stock')
      err.statusCode = 400
      err.code = 'UNAVAILABLE_PRODUCT_REJECTED'
      throw err
    }

    const cart = await this.repository.findOrCreateCart(customerId)
    const productSnapshot = {
      id: product.id,
      name: product.name,
      slug: product.slug,
      unit_price: product.price,
      currency: product.currency || 'INR',
    }

    const item = await this.repository.addOrUpdateCartItem(
      cart.id,
      product_id,
      quantity,
      product.price,
      productSnapshot
    )

    logger.info({ customerId, cartId: cart.id, productId: product_id, quantity }, 'Cart item added')
    return this.repository.getCartWithItems(customerId)
  }

  async updateItemQuantity(customerId, productId, quantity) {
    const cart = await this.repository.findOrCreateCart(customerId)
    const updated = await this.repository.updateCartItemQuantity(cart.id, productId, quantity)

    if (!updated) {
      const err = new Error('Cart item not found')
      err.statusCode = 404
      err.code = 'CART_ITEM_NOT_FOUND'
      throw err
    }

    return this.repository.getCartWithItems(customerId)
  }

  async removeItem(customerId, productId) {
    const cart = await this.repository.findOrCreateCart(customerId)
    const removed = await this.repository.removeCartItem(cart.id, productId)
    if (!removed) {
      const err = new Error('Cart item not found')
      err.statusCode = 404
      err.code = 'CART_ITEM_NOT_FOUND'
      throw err
    }
    return this.repository.getCartWithItems(customerId)
  }

  async clearCart(customerId) {
    const cart = await this.repository.findOrCreateCart(customerId)
    await this.repository.clearCart(cart.id)
    return { success: true, message: 'Cart cleared' }
  }

  // ─── LOYALTY LEDGER SERVICES ────────────────────────
  async getLoyaltyHistory(customerId) {
    return this.repository.getLoyaltyHistory(customerId)
  }

  async processLoyaltyTransaction(customerId, payload) {
    const { transaction_type, points, reference_id = null, idempotency_key = null } = payload

    if (idempotency_key) {
      const existingTx = await this.repository.findLoyaltyTxByIdempotencyKey(idempotency_key)
      if (existingTx) {
        logger.info({ idempotency_key }, 'Duplicate loyalty transaction skipped via idempotency key')
        return existingTx
      }
    }

    const account = await this.repository.findOrCreateLoyaltyAccount(customerId)
    const currentBalance = Number(account.points_balance)
    let newBalance = currentBalance

    if (transaction_type === 'EARN' || transaction_type === 'ADJUSTMENT') {
      newBalance += Number(points)
    } else if (transaction_type === 'REDEEM' || transaction_type === 'EXPIRE') {
      if (currentBalance < Number(points)) {
        const err = new Error(`Insufficient loyalty balance. Required: ${points}, Available: ${currentBalance}`)
        err.statusCode = 400
        err.code = 'INSUFFICIENT_LOYALTY_BALANCE'
        throw err
      }
      newBalance -= Number(points)
    }

    const tx = await this.repository.writeLoyaltyTransaction(
      account.id,
      transaction_type,
      Number(points),
      newBalance,
      reference_id,
      idempotency_key
    )

    logger.info({ customerId, transaction_type, points, newBalance }, 'Loyalty transaction recorded')
    return tx
  }

  // ─── CHECKOUT QUOTE SERVICES ─────────────────────────
  /**
   * Marketplace checkout quote. The backend is the ONLY pricing authority
   * (spec §24): every value below comes from real configuration —
   *   - coupons via the coupon engine (type, caps, scope, usage limits),
   *   - GST from fee_settings.gst_enabled/gst_rate or product-level gst_rate,
   *   - loyalty redemption clamped to the admin-configured cap
   *     (max_redemption_pct of the eligible subtotal — never uncapped),
   *   - delivery fee from the fee engine (single-shop estimate).
   * Sample/demo math (10%/₹100 discount, flat 5% GST, 1pt=₹1 uncapped) was
   * removed per spec §37.
   */
  async generateCheckoutQuote(customerId, payload = {}) {
    const { loyalty_points_to_redeem = 0, discount_code = null, ttl_seconds = 900 } = payload
    const cart = await this.repository.getCartWithItems(customerId)

    if (!cart.items || cart.items.length === 0) {
      const err = new Error('Cart is empty. Cannot generate checkout quote.')
      err.statusCode = 400
      err.code = 'EMPTY_CART_QUOTE_REJECTED'
      throw err
    }

    // Validate product availability and snapshot prices
    let subtotal = 0
    const snapshotItems = []

    for (const item of cart.items) {
      const itemSubtotal = Number(item.unit_price) * Number(item.quantity)
      subtotal += itemSubtotal
      snapshotItems.push({
        product_id: item.product_id,
        name: item.product_name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        subtotal: itemSubtotal,
      })
    }

    const breakdown = { coupon: null, loyalty: null, tax: null, delivery: null }

    // ── 1. Real coupon engine ───────────────────────────────────────────
    let discountAmount = 0
    let freeDelivery = false
    let couponMeta = null
    if (discount_code) {
      const { CouponsService } = await import('../coupons/coupons.service.js')
      const { CouponsRepository } = await import('../coupons/coupons.repository.js')
      const couponsService = this.couponsService || new CouponsService(new CouponsRepository())
      const validation = await couponsService.validate(customerId, discount_code, subtotal, snapshotItems)
      if (!validation.valid) {
        const err = new Error(validation.message || 'Coupon is not applicable to this cart')
        err.statusCode = 400
        err.code = 'COUPON_INVALID'
        throw err
      }
      // discount is 0 for CASHBACK/FREE_DELIVERY types (the engine surfaces
      // their effects separately); PERCENTAGE/FLAT come pre-computed and
      // capped by the engine (maxDiscount + scoped subtotal).
      discountAmount = Math.min(Number(validation.discount || 0), subtotal)
      freeDelivery = !!validation.freeDelivery
      couponMeta = {
        code: validation.code,
        couponId: validation.couponId,
        discountType: validation.discountType,
        cashbackAmount: validation.cashbackAmount || 0,
        cashbackCreditTrigger: validation.cashbackCreditTrigger || null,
      }
      breakdown.coupon = { code: validation.code, discount: discountAmount, freeDelivery, type: validation.discountType }
    }

    // ── 2. Loyalty redemption, clamped to the admin-configured cap ──────
    let loyaltyRedeemedAmount = 0
    const requestedPoints = Math.floor(Number(loyalty_points_to_redeem || 0))
    if (requestedPoints > 0) {
      const { LoyaltyService } = await import('../loyalty/loyalty.service.js')
      const loyalty = this.loyaltyService || new LoyaltyService()
      const settings = await loyalty.getSettings()
      if (!settings.enabled) {
        const err = new Error('Loyalty redemption is disabled')
        err.statusCode = 400
        err.code = 'LOYALTY_DISABLED'
        throw err
      }
      // Eligible value = subtotal minus coupon discount (points never pay
      // for shipping/tax or a discount the coupon already covered).
      const eligibleSubtotal = Math.max(0, subtotal - discountAmount)
      const { maxPoints, pointValue } = await loyalty.computeMaxRedeemable(customerId, eligibleSubtotal)
      if (requestedPoints > maxPoints) {
        const err = new Error(
          `You can redeem at most ${maxPoints} points on this order (admin cap: ${Number(settings.max_redemption_pct)}% of eligible value).`
        )
        err.statusCode = 400
        err.code = 'LOYALTY_CAP_EXCEEDED'
        err.maxPoints = maxPoints
        throw err
      }
      loyaltyRedeemedAmount = Number((requestedPoints * pointValue).toFixed(2))
      breakdown.loyalty = { points: requestedPoints, value: loyaltyRedeemedAmount, maxPoints, pointValue }
    }

    // ── 3. Real tax (GST) configuration ─────────────────────────────────
    let taxAmount = 0
    try {
      const { FeeSettingsService } = await import('../fee-settings/fee-settings.service.js')
      const feeSettings = this.feeSettingsService || new FeeSettingsService()
      const global = await feeSettings.getGlobal()
      if (global?.gst_enabled) {
        const taxBase = Math.max(0, subtotal - discountAmount - loyaltyRedeemedAmount)
        // Product-level gst_rate (154) wins; platform default otherwise.
        const productRates = await this.repository.getProductGstRates?.(
          snapshotItems.map((i) => i.product_id)
        )
        if (Array.isArray(productRates) && productRates.length) {
          const rateById = new Map(productRates.map((r) => [r.id, Number(r.gst_rate)]))
          taxAmount = snapshotItems.reduce((sum, item) => {
            const rate = rateById.get(item.product_id) ?? Number(global.gst_rate)
            return sum + (item.subtotal * rate) / 100
          }, 0)
        } else {
          taxAmount = (taxBase * Number(global.gst_rate)) / 100
        }
        taxAmount = Number(taxAmount.toFixed(2))
        breakdown.tax = { enabled: true, label: global.gst_label || 'GST', amount: taxAmount }
      }
    } catch (err) {
      logger.warn({ err }, 'GST settings unavailable for quote — tax 0')
      breakdown.tax = { enabled: false, amount: 0 }
    }

    // ── 4. Delivery fee estimate from the fee engine (real config) ──────
    let deliveryFee = 0
    try {
      const { FeeSettingsService } = await import('../fee-settings/fee-settings.service.js')
      const feeSettings = this.feeSettingsService || new FeeSettingsService()
      const global = await feeSettings.getGlobal()
      const threshold = Number(global?.free_delivery_threshold ?? 0)
      const baseFee = Number(global?.delivery_fee ?? 0)
      deliveryFee = threshold > 0 && subtotal >= threshold ? 0 : baseFee
      if (freeDelivery) deliveryFee = 0
      breakdown.delivery = { estimated: true, fee: deliveryFee, freeDeliveryWaived: freeDelivery }
    } catch (err) {
      logger.warn({ err }, 'Fee settings unavailable for quote — delivery estimate 0')
      breakdown.delivery = { estimated: false, fee: 0 }
    }

    const totalPayable = Number(
      (Math.max(0, subtotal - discountAmount - loyaltyRedeemedAmount) + taxAmount + deliveryFee).toFixed(2)
    )

    const quoteNumber = `Q-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`
    const expiresAt = new Date(Date.now() + ttl_seconds * 1000)

    const quote = await this.repository.createQuote({
      quote_number: quoteNumber,
      customer_id: customerId,
      cart_snapshot: { items: snapshotItems, breakdown },
      subtotal,
      discount_amount: discountAmount,
      loyalty_redeemed_amount: loyaltyRedeemedAmount,
      tax_amount: taxAmount,
      total_payable: totalPayable,
      expires_at: expiresAt,
    })

    logger.info({ quoteNumber, customerId, totalPayable, expiresAt }, 'Checkout quote generated')
    return { ...quote, breakdown, delivery_fee: deliveryFee, coupon: couponMeta }
  }

  async getQuoteByNumber(quoteNumber) {
    const quote = await this.repository.findQuoteByNumber(quoteNumber)
    if (!quote) {
      const err = new Error('Checkout quote not found')
      err.statusCode = 404
      err.code = 'QUOTE_NOT_FOUND'
      throw err
    }

    if (new Date(quote.expires_at) <= new Date()) {
      const err = new Error('Checkout quote has expired')
      err.statusCode = 400
      err.code = 'QUOTE_EXPIRED'
      throw err
    }

    return quote
  }
}
