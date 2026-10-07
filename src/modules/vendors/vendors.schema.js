/**
 * Vendor Domain Schemas & DTO Validation
 * Source of truth: Blueprint §06.1, Phase 2A
 *
 * @module modules/vendors/vendors.schema
 */

export const CreateVendorSchema = {
  type: 'object',
  required: ['name', 'email', 'phone'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 255 },
    email: { type: 'string', format: 'email', maxLength: 255 },
    phone: { type: 'string', pattern: '^[0-9+]{8,20}$' },
    slug: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 255 },
    status: { type: 'string', enum: ['PENDING_ONBOARDING', 'KYC_SUBMITTED', 'VERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] },
  },
  additionalProperties: false,
}

export const UpdateVendorSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 255 },
    email: { type: 'string', format: 'email', maxLength: 255 },
    phone: { type: 'string', pattern: '^[0-9+]{8,20}$' },
    slug: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 255 },
    is_active: { type: 'boolean' },
  },
  additionalProperties: false,
}

export const UpdateVendorStatusSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['PENDING_ONBOARDING', 'KYC_SUBMITTED', 'VERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] },
    reason: { type: 'string', maxLength: 500 },
  },
  additionalProperties: false,
}

export const UpdateVendorProfileSchema = {
  type: 'object',
  properties: {
    legal_name: { type: 'string', maxLength: 255 },
    trade_license_number: { type: 'string', maxLength: 100 },
    gstin: { type: 'string', maxLength: 50 },
    fssai_license: { type: 'string', maxLength: 100 },
    pan_number: { type: 'string', maxLength: 50 },
    address_line1: { type: 'string' },
    address_line2: { type: 'string' },
    city: { type: 'string', maxLength: 100 },
    state: { type: 'string', maxLength: 100 },
    pincode: { type: 'string', maxLength: 20 },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    metadata: { type: 'object' },
  },
  additionalProperties: false,
}

export const UpdateVendorSettingsSchema = {
  type: 'object',
  properties: {
    auto_accept_orders: { type: 'boolean' },
    commission_rate: { type: 'number', minimum: 0, maximum: 100 },
    payout_schedule: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY'] },
    notification_email: { type: 'string', format: 'email' },
    notification_phone: { type: 'string' },
    operating_hours: { type: 'object' },
  },
  additionalProperties: false,
}

export const VendorQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    search: { type: 'string' },
    status: { type: 'string', enum: ['PENDING_ONBOARDING', 'KYC_SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'VERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'REJECTED'] },
    is_active: { type: 'boolean' },
  },
}
