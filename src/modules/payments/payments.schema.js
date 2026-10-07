/**
 * Payments JSON schemas for request/response validation
 */

const paymentResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    razorpayOrderId: { type: ['string', 'null'] },
    razorpayPaymentId: { type: ['string', 'null'] },
    amount: { type: 'number' },
    currency: { type: 'string' },
    status: { type: 'string' },
    method: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
}

export const createPaymentOrderSchema = {
  tags: ['Payments'],
  summary: 'Create a Razorpay payment order for an existing order',
  body: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            paymentId: { type: 'string' },
            razorpayOrderId: { type: 'string' },
            amount: { type: 'number' },
            currency: { type: 'string' },
            keyId: { type: 'string' },
          },
        },
      },
    },
  },
}

export const verifyPaymentSchema = {
  tags: ['Payments'],
  summary: 'Verify Razorpay payment signature',
  body: {
    type: 'object',
    required: ['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature'],
    properties: {
      razorpayOrderId: { type: 'string' },
      razorpayPaymentId: { type: 'string' },
      razorpaySignature: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: paymentResponseSchema,
      },
    },
  },
}

export const webhookSchema = {
  tags: ['Payments'],
  summary: 'Razorpay webhook handler',
  // No schema validation — webhook body varies by event
}

export const paymentStatusSchema = {
  tags: ['Payments'],
  summary: 'Poll the real, locally-known payment status by Razorpay order id',
  params: {
    type: 'object',
    required: ['razorpayOrderId'],
    properties: {
      razorpayOrderId: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            orderId: { type: 'string', format: 'uuid' },
            errorCode: { type: ['string', 'null'] },
            errorDescription: { type: ['string', 'null'] },
            errorReason: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
}

export const paymentHistorySchema = {
  tags: ['Payments'],
  summary: 'Get payment history for current user',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: paymentResponseSchema },
        pagination: { type: 'object' },
      },
    },
  },
}

export const refundSchema = {
  tags: ['Payments', 'Admin'],
  summary: 'Initiate refund for a payment (admin)',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      amount: { type: 'number', minimum: 1 },
      reason: { type: 'string', maxLength: 500 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: paymentResponseSchema,
      },
    },
  },
}
