const STATUSES = ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED']
const SCOPES = ['FULL_ORDER', 'ITEMS']
const DESTINATIONS = ['RAZORPAY', 'WALLET']

export const listReturnsSchema = {
  tags: ['Admin', 'Returns'],
  summary: 'List refund/return requests [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: STATUSES },
      customerId: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
}

export const returnIdSchema = {
  tags: ['Admin', 'Returns'],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const createReturnSchema = {
  tags: ['Admin', 'Returns'],
  summary: 'File a return/refund request on a customer\'s behalf [ADMIN]',
  body: {
    type: 'object',
    required: ['orderId', 'scope', 'reason', 'refundDestination'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
      scope: { type: 'string', enum: SCOPES },
      productIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Alternative to itemIndexes — the products being returned',
      },
      itemIndexes: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        description: 'Required when scope=ITEMS — indexes into the order\'s items array',
      },
      reason: { type: 'string', minLength: 3, maxLength: 500 },
      refundDestination: { type: 'string', enum: DESTINATIONS },
      adminNotes: { type: 'string', maxLength: 1000 },
    },
  },
}

export const resolveReturnSchema = {
  tags: ['Admin', 'Returns'],
  params: returnIdSchema.params,
  body: {
    type: 'object',
    properties: {
      adminNotes: { type: 'string', maxLength: 1000 },
      refundTo: { type: 'string', enum: DESTINATIONS, description: 'Approve only — override the refund destination' },
    },
  },
}
