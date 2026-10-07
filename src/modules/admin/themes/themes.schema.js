export const themeIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const createThemeSchema = {
  body: {
    type: 'object',
    required: ['name', 'theme_data'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      theme_data: { type: 'object' },
      // Which physical shop this theme belongs to — omitted/null means the
      // platform-default theme (Requirement: per-store branding).
      shop_id: { type: ['string', 'null'], format: 'uuid' },
      tab_id: { type: 'string', format: 'uuid' },
      tab_key: { type: 'string', maxLength: 50 },
      tab_label: { type: 'string', maxLength: 100 },
      tab_icon_url: { type: 'string' },
      tab_order: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: ['draft', 'active', 'scheduled', 'archived'] },
      ab_variant: { type: 'string', enum: ['A', 'B'] },
      ab_split_percent: { type: 'integer', minimum: 0, maximum: 100 },
    },
  },
}

export const updateThemeSchema = {
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
      name: { type: 'string', maxLength: 100 },
      theme_data: { type: 'object' },
      shop_id: { type: ['string', 'null'], format: 'uuid' },
      tab_id: { type: ['string', 'null'], format: 'uuid' },
      tab_key: { type: 'string', maxLength: 50 },
      tab_label: { type: 'string', maxLength: 100 },
      tab_icon_url: { type: 'string' },
      tab_order: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: ['draft', 'active', 'scheduled', 'archived'] },
      ab_variant: { type: 'string', enum: ['A', 'B'] },
      ab_split_percent: { type: 'integer', minimum: 0, maximum: 100 },
    },
  },
}

export const scheduleThemeSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['scheduled_at'],
    properties: {
      scheduled_at: { type: 'string', format: 'date-time' },
    },
  },
}

export const rollbackSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['version_id'],
    properties: {
      version_id: { type: 'string', format: 'uuid' },
    },
  },
}
