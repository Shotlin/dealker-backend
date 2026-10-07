/**
 * System Role Taxonomy for Meet Commerce Platform
 * Source of truth: Blueprint §05.1, §05.2, §09.2
 *
 * Defines the 17 system roles across 4 functional domains,
 * while preserving legacy role constants for 100% backward compatibility.
 *
 * @module constants/roles
 */

export const ROLES = Object.freeze({
  // ── Admin / HQ Platform Roles (8) ──────────────────────────────────
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  HQ_MANAGER: 'HQ_MANAGER',
  SUPPORT_AGENT: 'SUPPORT_AGENT',
  FINANCE_USER: 'FINANCE_USER',
  CONTENT_MANAGER: 'CONTENT_MANAGER',
  MARKETING_USER: 'MARKETING_USER',
  READ_ONLY_ANALYST: 'READ_ONLY_ANALYST',

  // ── Vendor Scope Roles (2) ─────────────────────────────────────────
  VENDOR_OWNER: 'VENDOR_OWNER',
  VENDOR_OPERATOR: 'VENDOR_OPERATOR',

  // ── Warehouse Scope Roles (5) ──────────────────────────────────────
  WAREHOUSE_RECEIVER: 'WAREHOUSE_RECEIVER',
  QUALITY_CONTROLLER: 'QUALITY_CONTROLLER',
  PICKER: 'PICKER',
  PACKER: 'PACKER',
  INVENTORY_MANAGER: 'INVENTORY_MANAGER',

  // ── User / Operations Roles (2) ────────────────────────────────────
  RIDER: 'RIDER',
  CUSTOMER: 'CUSTOMER',

  // ── Legacy Compatibility Aliases ───────────────────────────────────
  HQ_FINANCE: 'HQ_FINANCE',
  HQ_SUPPORT: 'HQ_SUPPORT',
  SHOP_ADMIN: 'SHOP_ADMIN',
  SHOP_MANAGER: 'SHOP_MANAGER',
  SHOP_STAFF: 'SHOP_STAFF',
  SHOP_VIEWER: 'SHOP_VIEWER',
})

/**
 * Functional role groupings for authorization domain scoping
 */
export const ROLE_GROUPS = Object.freeze({
  PLATFORM: Object.freeze([
    ROLES.SUPER_ADMIN,
    ROLES.ADMIN,
    ROLES.HQ_MANAGER,
    ROLES.SUPPORT_AGENT,
    ROLES.FINANCE_USER,
    ROLES.CONTENT_MANAGER,
    ROLES.MARKETING_USER,
    ROLES.READ_ONLY_ANALYST,
    ROLES.HQ_FINANCE,
    ROLES.HQ_SUPPORT,
  ]),
  VENDOR: Object.freeze([
    ROLES.VENDOR_OWNER,
    ROLES.VENDOR_OPERATOR,
    ROLES.SHOP_ADMIN,
    ROLES.SHOP_MANAGER,
    ROLES.SHOP_STAFF,
    ROLES.SHOP_VIEWER,
  ]),
  WAREHOUSE: Object.freeze([
    ROLES.WAREHOUSE_RECEIVER,
    ROLES.QUALITY_CONTROLLER,
    ROLES.PICKER,
    ROLES.PACKER,
    ROLES.INVENTORY_MANAGER,
  ]),
  OPERATIONAL: Object.freeze([
    ROLES.RIDER,
    ROLES.CUSTOMER,
  ]),
})

export const ALL_ROLES = Object.freeze(Object.values(ROLES))
