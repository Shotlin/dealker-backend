const EVENT_TYPES = [
  'ORDER_PLACED',
  'ORDER_STATUS',
  'WALLET',
  'NOTIFICATION',
  'REVIEW',
  'PRODUCT_VIEW',
  'CART_EVENT',
  'ADDRESS_ADDED',
  'ADDRESS_REMOVED',
]

export const resolveCustomerActivityUserSchema = {
  tags: ['Admin', 'Customer Activity'],
  summary: 'Resolve a User ID or phone number to name/phone/last_active_at [ADMIN]',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
}

export const searchCustomerActivityUsersSchema = {
  tags: ['Admin', 'Customer Activity'],
  summary: 'Real-time search-as-you-type customer suggestions by name, phone, or user ID [ADMIN]',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
}

export const getCustomerActivityTimelineSchema = {
  tags: ['Admin', 'Customer Activity'],
  summary: "Paginated, filterable activity timeline for one customer [ADMIN]",
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      eventType: { type: 'string', enum: EVENT_TYPES },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
    },
  },
}
