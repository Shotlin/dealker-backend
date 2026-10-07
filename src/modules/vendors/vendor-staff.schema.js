/**
 * Vendor Staff Management Schemas & DTO Validation
 * Source of truth: Blueprint §06.1, Phase 2C
 *
 * @module modules/vendors/vendor-staff.schema
 */

export const InviteStaffSchema = {
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    role: { type: 'string', enum: ['VENDOR_OWNER', 'VENDOR_OPERATOR'], default: 'VENDOR_OPERATOR' },
  },
  additionalProperties: false,
}

export const UpdateStaffRoleSchema = {
  type: 'object',
  required: ['role'],
  properties: {
    role: { type: 'string', enum: ['VENDOR_OWNER', 'VENDOR_OPERATOR'] },
  },
  additionalProperties: false,
}

export const RespondInvitationSchema = {
  type: 'object',
  required: ['token', 'action'],
  properties: {
    token: { type: 'string', minLength: 1 },
    action: { type: 'string', enum: ['ACCEPT', 'REJECT'] },
  },
  additionalProperties: false,
}
