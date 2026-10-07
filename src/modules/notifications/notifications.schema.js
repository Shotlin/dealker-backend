export const getNotificationsSchema = {
  tags: ['Notifications'],
  summary: 'Get user notifications',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 20 },
      unreadOnly: { type: 'boolean', default: false },
    },
  },
}

export const markAsReadSchema = {
  tags: ['Notifications'],
  summary: 'Mark notification as read',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const markAllAsReadSchema = {
  tags: ['Notifications'],
  summary: 'Mark all notifications as read',
}

export const markCampaignOpenedSchema = {
  tags: ['Notifications'],
  summary: 'Record that the current user opened a campaign push notification',
  params: {
    type: 'object',
    required: ['campaignId'],
    properties: {
      campaignId: { type: 'string', format: 'uuid' },
    },
  },
}

export const deleteNotificationSchema = {
  tags: ['Notifications'],
  summary: 'Delete notification',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getPreferencesSchema = {
  tags: ['Notifications'],
  summary: 'Get notification preferences',
}

export const updatePreferencesSchema = {
  tags: ['Notifications'],
  summary: 'Update notification preferences',
  body: {
    type: 'object',
    properties: {
      orderUpdates: { type: 'boolean' },
      promotions: { type: 'boolean' },
      newProducts: { type: 'boolean' },
      deliveryUpdates: { type: 'boolean' },
      priceDrops: { type: 'boolean' },
    },
  },
}

export const registerTokenSchema = {
  tags: ['Notifications'],
  summary: 'Register FCM/device token',
  body: {
    type: 'object',
    required: ['token', 'platform'],
    properties: {
      token: { type: 'string' },
      platform: { type: 'string', enum: ['ios', 'android', 'web'] },
      // Omitted by the customer app (defaults to 'customer').
      app: { type: 'string', enum: ['customer', 'vendor', 'rider'] },
    },
  },
}
