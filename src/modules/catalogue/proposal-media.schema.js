/**
 * Proposal Media, Variants & Specifications Schemas
 * Source of truth: Blueprint §06.2, Phase 3B
 *
 * @module modules/catalogue/proposal-media.schema
 */

export const AddMediaSchema = {
  type: 'object',
  required: ['media_type', 'file_key'],
  properties: {
    media_type: { type: 'string', enum: ['IMAGE', 'VIDEO', 'PDF', 'CERTIFICATE', 'EVIDENCE_OTHER'] },
    file_key: { type: 'string', minLength: 1, maxLength: 255 },
    file_url: { type: 'string', maxLength: 512 },
    mime_type: { type: 'string', maxLength: 100 },
    size: { type: 'integer', minimum: 0 },
    sort_order: { type: 'integer', default: 0 },
    is_primary: { type: 'boolean', default: false },
  },
  additionalProperties: false,
}

export const AddVariantSchema = {
  type: 'object',
  required: ['sku', 'name'],
  properties: {
    sku: { type: 'string', minLength: 1, maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 255 },
    target_price: { type: 'number', minimum: 0 },
    attributes: { type: 'object' },
  },
  additionalProperties: false,
}

export const AddSpecificationSchema = {
  type: 'object',
  required: ['key', 'value'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 100 },
    value: { type: 'string', minLength: 1 },
    group_name: { type: 'string', maxLength: 100, default: 'General' },
  },
  additionalProperties: false,
}
