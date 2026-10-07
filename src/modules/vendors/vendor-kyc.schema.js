/**
 * Vendor KYC & Onboarding Schemas & DTO Validation
 * Source of truth: Blueprint §06.1, Phase 2B
 *
 * @module modules/vendors/vendor-kyc.schema
 */

export const SubmitKycSchema = {
  type: 'object',
  required: ['documents'],
  properties: {
    documents: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['document_type', 'file_key'],
        properties: {
          document_type: { type: 'string', enum: ['TRADE_LICENSE', 'GSTIN_CERTIFICATE', 'FSSAI_LICENSE', 'PAN_CARD', 'BANK_CANCELLED_CHEQUE', 'OTHER'] },
          document_number: { type: 'string', maxLength: 100 },
          file_key: { type: 'string', minLength: 1, maxLength: 255 },
          file_url: { type: 'string', maxLength: 512 },
        },
        additionalProperties: false,
      },
    },
    profile: {
      type: 'object',
      properties: {
        legal_name: { type: 'string' },
        trade_license_number: { type: 'string' },
        gstin: { type: 'string' },
        fssai_license: { type: 'string' },
        pan_number: { type: 'string' },
      },
    },
  },
  additionalProperties: false,
}

export const ReviewKycSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CORRECTION'] },
    comments: { type: 'string', maxLength: 500 },
  },
  additionalProperties: false,
}
