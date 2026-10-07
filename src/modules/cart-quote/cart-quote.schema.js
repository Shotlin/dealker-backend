/**
 * Cart, Loyalty Ledger & Checkout Quote Schemas
 * Source of truth: Blueprint §06.6, Phase 7
 *
 * @module modules/cart-quote/cart-quote.schema
 */

export const AddCartItemSchema = {
  type: 'object',
  required: ['product_id', 'quantity'],
  properties: {
    product_id: { type: 'string' },
    quantity: { type: 'number', exclusiveMinimum: 0 },
  },
  additionalProperties: false,
}

export const UpdateCartItemSchema = {
  type: 'object',
  required: ['quantity'],
  properties: {
    quantity: { type: 'number', exclusiveMinimum: 0 },
  },
  additionalProperties: false,
}

export const LoyaltyTransactionSchema = {
  type: 'object',
  required: ['transaction_type', 'points'],
  properties: {
    transaction_type: { type: 'string', enum: ['EARN', 'REDEEM', 'EXPIRE', 'ADJUSTMENT'] },
    points: { type: 'number', exclusiveMinimum: 0 },
    reference_id: { type: 'string' },
    idempotency_key: { type: 'string' },
  },
  additionalProperties: false,
}

export const GenerateQuoteSchema = {
  type: 'object',
  properties: {
    loyalty_points_to_redeem: { type: 'number', minimum: 0, default: 0 },
    discount_code: { type: 'string' },
    ttl_seconds: { type: 'integer', default: 900 }, // 15 min TTL
  },
  additionalProperties: false,
}
