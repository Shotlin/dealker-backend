/**
 * Cart, Loyalty & Quote Repository — Data Access Layer
 * Source of truth: Blueprint §06.6, Phase 7
 *
 * @module modules/cart-quote/cart-quote.repository
 */

import { query } from '../../config/database.js'

export class CartQuoteRepository {
  // ─── CART ───────────────────────────────────────────
  async findOrCreateCart(customerId) {
    const { rows } = await query(
      `INSERT INTO customer_carts (customer_id)
       VALUES ($1)
       ON CONFLICT (customer_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [customerId]
    )
    return rows[0]
  }

  async getCartWithItems(customerId) {
    const cart = await this.findOrCreateCart(customerId)
    const itemsRes = await query(
      `SELECT ci.*, p.name AS product_name, p.is_active AS product_is_active
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.created_at ASC`,
      [cart.id]
    )
    return { ...cart, items: itemsRes.rows }
  }

  async addOrUpdateCartItem(cartId, productId, quantity, unitPrice, productSnapshot) {
    const { rows } = await query(
      `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price, product_snapshot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, product_snapshot = EXCLUDED.product_snapshot, updated_at = NOW()
       RETURNING *`,
      [cartId, productId, quantity, unitPrice, JSON.stringify(productSnapshot)]
    )
    return rows[0]
  }

  async updateCartItemQuantity(cartId, productId, quantity) {
    const { rows } = await query(
      `UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND product_id = $2 RETURNING *`,
      [cartId, productId, quantity]
    )
    return rows[0] || null
  }

  async removeCartItem(cartId, productId) {
    const { rowCount } = await query(
      `DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cartId, productId]
    )
    return rowCount > 0
  }

  async clearCart(cartId) {
    await query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId])
  }

  async findProductById(productId) {
    const { rows } = await query(`SELECT * FROM products WHERE id = $1 LIMIT 1`, [productId])
    return rows[0] || null
  }

  // ─── LOYALTY LEDGER ─────────────────────────────────
  async findOrCreateLoyaltyAccount(customerId) {
    const { rows } = await query(
      `INSERT INTO loyalty_accounts (customer_id, points_balance)
       VALUES ($1, 0.00)
       ON CONFLICT (customer_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [customerId]
    )
    return rows[0]
  }

  async findLoyaltyTxByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null
    const { rows } = await query(
      `SELECT * FROM loyalty_transactions WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    )
    return rows[0] || null
  }

  async writeLoyaltyTransaction(accountId, type, points, balanceAfter, referenceId = null, idempotencyKey = null) {
    const { rows } = await query(
      `INSERT INTO loyalty_transactions (loyalty_account_id, transaction_type, points, balance_after, reference_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [accountId, type, points, balanceAfter, referenceId, idempotencyKey]
    )
    await query(`UPDATE loyalty_accounts SET points_balance = $2 WHERE id = $1`, [accountId, balanceAfter])
    return rows[0]
  }

  async getLoyaltyHistory(customerId) {
    const account = await this.findOrCreateLoyaltyAccount(customerId)
    const { rows } = await query(
      `SELECT * FROM loyalty_transactions WHERE loyalty_account_id = $1 ORDER BY created_at DESC`,
      [account.id]
    )
    return { account, transactions: rows }
  }

  // ─── CHECKOUT QUOTES ────────────────────────────────
  async createQuote({ quote_number, customer_id, cart_snapshot, subtotal, discount_amount, loyalty_redeemed_amount, tax_amount, total_payable, expires_at }) {
    const { rows } = await query(
      `INSERT INTO checkout_quotes (quote_number, customer_id, cart_snapshot, subtotal, discount_amount, loyalty_redeemed_amount, tax_amount, total_payable, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [quote_number, customer_id, JSON.stringify(cart_snapshot), subtotal, discount_amount, loyalty_redeemed_amount, tax_amount, total_payable, expires_at]
    )
    return rows[0]
  }

  async findQuoteByNumber(quoteNumber) {
    const { rows } = await query(
      `SELECT * FROM checkout_quotes WHERE quote_number = $1 LIMIT 1`,
      [quoteNumber]
    )
    return rows[0] || null
  }

  /** Product-level GST rates (migration 154) for quote tax math. */
  async getProductGstRates(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return []
    const { rows } = await query(
      `SELECT id, gst_rate FROM products WHERE id = ANY($1::uuid[]) AND gst_rate IS NOT NULL`,
      [productIds]
    )
    return rows
  }
}
