/**
 * Razorpay admin settings JSON Schemas
 */

export const getSettingsSchema = {
  tags: ['Admin - Payments'],
  summary: 'Get Razorpay TEST/PRODUCTION settings (masked)',
  security: [{ bearerAuth: [] }],
}

export const testSettingsSchema = {
  tags: ['Admin - Payments'],
  summary: 'Test Razorpay credentials (draft or stored) without saving or activating',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['TEST', 'PRODUCTION'] },
      // Both omitted -> test whichever credentials are already stored for `mode`.
      keyId: { type: 'string', minLength: 1, maxLength: 200 },
      keySecret: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
}

export const saveCredentialsSchema = {
  tags: ['Admin - Payments'],
  summary: 'Save Razorpay credentials for one environment (does not activate it)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['TEST', 'PRODUCTION', 'test', 'production'] },
    },
  },
  body: {
    type: 'object',
    properties: {
      // Omit a field to leave it untouched; empty string clears it.
      keyId: { type: 'string', maxLength: 200 },
      keySecret: { type: 'string', maxLength: 500 },
      webhookSecret: { type: 'string', maxLength: 500 },
    },
  },
}

export const activateSchema = {
  tags: ['Admin - Payments'],
  summary: 'Switch which environment (TEST/PRODUCTION) is live for real payment traffic',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['TEST', 'PRODUCTION'] },
      // Required (true) when mode is PRODUCTION — the dashboard's own
      // confirmation dialog is what actually sets this.
      confirm: { type: 'boolean' },
    },
  },
}
