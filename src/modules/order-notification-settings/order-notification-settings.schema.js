export const listSettingsSchema = {
  tags: ['Order Notification Settings'],
  summary: 'All 10 order-lifecycle notification/banner settings (admin)',
}

export const getCustomerFlagsSchema = {
  tags: ['Order Notification Settings'],
  summary: 'Per-event {notification, banner} enabled flags — what the mobile app checks before showing a push or the home-screen tracking banner',
}

export const updateSettingSchema = {
  tags: ['Order Notification Settings'],
  summary: 'Edit one event\'s title/message/enabled flags',
  params: {
    type: 'object',
    required: ['eventKey'],
    properties: { eventKey: { type: 'string' } },
  },
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      message: { type: 'string', minLength: 1, maxLength: 2000 },
      notificationEnabled: { type: 'boolean' },
      bannerEnabled: { type: 'boolean' },
      imageUrl: { type: 'string', maxLength: 2000 },
    },
  },
}

export const sendTestSchema = {
  tags: ['Order Notification Settings'],
  summary: 'Send a real test push (with sample order data) of this event to your own account',
  params: {
    type: 'object',
    required: ['eventKey'],
    properties: { eventKey: { type: 'string' } },
  },
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 200 },
      message: { type: 'string', maxLength: 2000 },
    },
  },
}
