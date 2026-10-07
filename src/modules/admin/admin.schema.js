// ─── Dashboard ────────────────────────────────────────
export const getDashboardSchema = {
  tags: ['Admin'],
  summary: 'Get admin dashboard statistics',
}

// ─── Analytics ────────────────────────────────────────
export const getSalesAnalyticsSchema = {
  tags: ['Admin'],
  summary: 'Sales analytics by date range',
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
      groupBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
    },
  },
}

export const getTopProductsSchema = {
  tags: ['Admin'],
  summary: 'Top selling products',
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'number', default: 20, minimum: 1, maximum: 100 },
    },
  },
}

export const getUserAnalyticsSchema = {
  tags: ['Admin'],
  summary: 'User growth & retention analytics',
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

// ─── Users ────────────────────────────────────────────
export const getAllUsersSchema = {
  tags: ['Admin'],
  summary: 'Get all users with pagination',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 20 },
      search: { type: 'string' },
      role: { type: 'string', enum: ['CUSTOMER', 'ADMIN', 'RIDER'] },
    },
  },
}

export const updateUserRoleSchema = {
  tags: ['Admin'],
  summary: 'Update user role',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['role'],
    properties: {
      role: { type: 'string', enum: ['CUSTOMER', 'ADMIN', 'RIDER'] },
    },
  },
}

export const blockUserSchema = {
  tags: ['Admin'],
  summary: 'Block or unblock a user',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['blocked'],
    properties: {
      blocked: { type: 'boolean' },
      reason: { type: 'string', maxLength: 500 },
    },
  },
}

// ─── Order Stats ──────────────────────────────────────
export const getOrderStatsSchema = {
  tags: ['Admin'],
  summary: 'Get order statistics',
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

// ─── Riders ───────────────────────────────────────────
export const getAllRidersSchema = {
  tags: ['Admin'],
  summary: 'List all riders',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 20 },
      status: { type: 'string', enum: ['approved', 'pending', 'online'] },
    },
  },
}

export const approveRiderSchema = {
  tags: ['Admin'],
  summary: 'Approve rider registration',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

// ─── Bulk Notification ────────────────────────────────
export const sendBulkNotificationSchema = {
  tags: ['Admin'],
  summary: 'Send push notification to users',
  body: {
    type: 'object',
    required: ['title', 'body', 'target'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 1000 },
      target: { type: 'string', enum: ['all', 'role'] },
      role: { type: 'string', enum: ['CUSTOMER', 'RIDER'] },
    },
  },
}

// ─── Settings ─────────────────────────────────────────
export const getSettingsSchema = {
  tags: ['Admin'],
  summary: 'Get all app settings',
}

export const updateSettingsSchema = {
  tags: ['Admin'],
  summary: 'Update app settings',
  body: {
    type: 'object',
    additionalProperties: true,
  },
}
