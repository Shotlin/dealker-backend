/**
 * Orders & Fulfilment Schemas
 * Source of truth: Blueprint §06.7, Phase 8
 *
 * @module modules/orders/orders.schema
 */

export const CreateOrderFromQuoteSchema = {
  type: 'object',
  required: ['quote_number'],
  properties: {
    quote_number: { type: 'string', minLength: 1 },
    warehouse_id: { type: 'string' },
  },
  additionalProperties: false,
}

export const PlaceMobileOrderSchema = {
  type: 'object',
  required: ['addressId', 'paymentMethod'],
  properties: {
    addressId: { type: 'string', format: 'uuid' },
    paymentMethod: { type: 'string', enum: ['COD', 'ONLINE', 'WALLET'] },
    priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
    couponCode: { type: 'string', maxLength: 50 },
    deliveryNotes: { type: 'string', maxLength: 500 },
    deliveryMode: { type: 'string', enum: ['ASAP', 'SCHEDULED'] },
    scheduledDeliveryAt: { type: 'string' },
    scheduledSlotStart: { type: 'string' },
    scheduledSlotEnd: { type: 'string' },
    scheduledSlotLabel: { type: 'string', maxLength: 100 },
    quickDeliverySelected: { type: 'boolean' },
    useWallet: { type: 'boolean' },
    // Idempotency key — one per checkout attempt, reused only when the
    // mobile app retries that exact same attempt. See
    // OrdersService#placeOrder's doc comment.
    clientOrderRef: { type: 'string', format: 'uuid' },
  },
  additionalProperties: false,
}

export const UpdateOrderStatusSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: {
      type: 'string',
      enum: [
        'CART_CREATED', 'ORDER_PLACED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED',
        'CONFIRMED', 'ALLOCATING_STOCK', 'STOCK_RESERVED', 'PICKING', 'PACKING',
        'READY_FOR_DISPATCH', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED',
        'COMPLETED', 'CANCELLED', 'PAYMENT_FAILED', 'RETURN_REQUESTED', 'RETURNED'
      ],
    },
    notes: { type: 'string' },
  },
  additionalProperties: false,
}

export const CreateFulfilmentTaskSchema = {
  type: 'object',
  required: ['task_type'],
  properties: {
    task_type: { type: 'string', enum: ['PICKING', 'PACKING'] },
    assigned_to: { type: 'string' },
    notes: { type: 'string' },
  },
  additionalProperties: false,
}

export const UpdateFulfilmentTaskSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'] },
    notes: { type: 'string' },
  },
  additionalProperties: false,
}
