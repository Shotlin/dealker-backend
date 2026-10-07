/**
 * Canonical RBAC vocabulary, permission groups, and role → permission maps for Meet Commerce.
 *
 * Single runtime source of truth for:
 *   - Exactly 67 Canonical Permission_Strings.
 *   - Reusable Permission Groups.
 *   - Role → Permission mappings for all 17 system roles + legacy aliases.
 *
 * Requirements satisfied:
 *   - Blueprint §05.1 & §05.2 — Canonical Permission Registry (67 permissions).
 *   - Backward compatibility — 37 legacy permission strings, HQ_ROLE_PERMISSIONS, and
 *     SHOP_ROLE_DEFAULT_PERMISSIONS preserved verbatim.
 *
 * @module utils/permissions
 */

/**
 * The complete canonical registry of exactly 67 Permission_Strings.
 * Includes 37 legacy preserved strings + 30 new domain permissions.
 *
 * @type {ReadonlyArray<string>}
 */
const CANONICAL_PERMISSION_LIST = Object.freeze([
  // ── Legacy Preserved Permissions (37) ──────────────────────────────────
  'audit_logs.view',
  'finance.global_view',
  'reports.global_view',
  'riders.approve',
  'riders.assign',
  'riders.view',
  'shop_coupons.create',
  'shop_coupons.delete',
  'shop_coupons.update',
  'shop_coupons.view',
  'shop_financials.export',
  'shop_financials.mark_paid',
  'shop_financials.view',
  'shop_orders.assign_rider',
  'shop_orders.cancel',
  'shop_orders.export',
  'shop_orders.refund',
  'shop_orders.update_status',
  'shop_orders.view',
  'shop_products.approve',
  'shop_products.bulk_update',
  'shop_products.create',
  'shop_products.delete',
  'shop_products.update',
  'shop_products.view',
  'shop_reports.view',
  'shop_staff.create',
  'shop_staff.delete',
  'shop_staff.reset_password',
  'shop_staff.update',
  'shop_staff.view',
  'shop_transactions.export',
  'shop_transactions.view',
  'shops.create',
  'shops.delete',
  'shops.update',
  'shops.view',

  // ── New Meet Commerce Domain Permissions (30) ──────────────────────────
  'batch_evidence.moderate',
  'batch_evidence.upload',
  'batch_evidence.view',
  'delivery_tasks.assign',
  'delivery_tasks.fail',
  'delivery_tasks.override',
  'delivery_tasks.update',
  'fulfilment.override',
  'fulfilment.pack',
  'fulfilment.pick',
  'fulfilment.view',
  'inventory_ledger.view',
  'inventory_lots.adjust',
  'inventory_lots.recall',
  'inventory_lots.transfer',
  'inventory_lots.view',
  'loyalty.adjust',
  'loyalty.configure',
  'loyalty.export',
  'loyalty.view',
  'procurement.cancel',
  'procurement.create',
  'procurement.respond',
  'procurement.update',
  'procurement.view',
  'procurement.approve',
  'product_proposals.approve',
  'product_proposals.create',
  'product_proposals.reject',
  'product_proposals.update',
  'product_proposals.view',
  'quality_control.decide',
  'quality_control.override',
  'quality_control.view',
  'quality_control.inspect',
  'quality_control.approve',
  'recalls.activate',
  'recalls.close',
  'recalls.create',
  'recalls.view',
  'recalls.manage',
  'reports.quality_view',
  'reports.traceability_view',
  'traceability.view',
  'supply_batches.create',
  'supply_batches.dispatch',
  'supply_batches.handover',
  'supply_batches.ready',
  'supply_batches.update',
  'supply_batches.view',
  'support_tickets.refund',
  'support_tickets.replace',
  'support_tickets.update',
  'support_tickets.view',
  'support.manage',
  'vendor_documents.verify',
  'vendor_documents.view',
  'vendor_staff.create',
  'vendor_staff.delete',
  'vendor_staff.update',
  'vendor_staff.view',
  'vendors.approve',
  'vendors.create',
  'vendors.suspend',
  'vendors.update',
  'vendors.view',
  'warehouse_receipts.create',
  'warehouse_receipts.submit_qc',
  'warehouse_receipts.update',
  'warehouse_receipts.view',
  'warehouses.create',
  'warehouses.update',
  'warehouses.view',
  // ── Inventory ──────────────────────────────────────────────────────────
  'inventory.manage',
  'inventory.reserve',
  'inventory.view',
  // ── Delivery & Logistics ───────────────────────────────────────────────
  'deliveries.manage',
  'deliveries.view',
  'fulfilment.manage',
  'riders.manage',
  // ── Orders ────────────────────────────────────────────────────────────
  'orders.update',
  // ── Reports ────────────────────────────────────────────────────────────
  'reports.view',
  // ── Marketplace (Dealker) ──────────────────────────────────────────────
  'seller_orders.view',
  'seller_orders.manage',
  'marketplace.listings.view',
  'marketplace.listings.moderate',
  'loyalty_settings.view',
  'loyalty_settings.manage',
  'referrals.view',
  'referrals.manage',
  'referral_settings.manage',
  'settlements.view',
  'settlements.manage',
  'shipping.view',
  'shipping.manage',
  'shipping_providers.manage',
  'b2b_supply.view',
  'b2b_supply.manage',
  'bulk_import.view',
  'bulk_import.manage',
  'refunds.view',
  'refunds.manage',
  'returns.view',
  'returns.manage',
  'vendor_profile.manage',
  // ── Auctions ───────────────────────────────────────────────────────────
  'auctions.view',
  'auctions.manage',
  'auctions.moderate',
  'auctions.settings',
  // ── Sponsored ads ──────────────────────────────────────────────────────
  'ads.view',
  'ads.manage',
  'ads.moderate',
  'ads.settings',
  'ads.billing',
])

/**
 * Frozen `Set<string>` of all 67 canonical permissions.
 * @type {Readonly<Set<string>>}
 */
export const PERMISSIONS = Object.freeze(new Set(CANONICAL_PERMISSION_LIST))

/**
 * Alias of `PERMISSIONS` for backward compatibility.
 * @type {Readonly<Set<string>>}
 */
export const CANONICAL_PERMISSIONS = PERMISSIONS

/**
 * Convenience array of HQ_Role identifiers.
 * @type {ReadonlyArray<string>}
 */
export const HQ_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'HQ_MANAGER',
  'HQ_FINANCE',
  'HQ_SUPPORT',
  'FINANCE_USER',
  'SUPPORT_AGENT',
  'CONTENT_MANAGER',
  'MARKETING_USER',
  'READ_ONLY_ANALYST',
])

// Helper: All 67 permissions array
const ALL_PERMISSIONS = CANONICAL_PERMISSION_LIST

// Shop-scoped subset (all permissions minus HQ global reports/finance/audit)
const SHOP_SCOPED_PERMISSIONS = Object.freeze(
  ALL_PERMISSIONS.filter(
    (p) => p !== 'reports.global_view' && p !== 'finance.global_view' && p !== 'audit_logs.view',
  ),
)

/**
 * Reusable Permission Groups by Domain Scope
 */
export const PERMISSION_GROUPS = Object.freeze({
  VENDORS: Object.freeze([
    'vendors.view',
    'vendors.create',
    'vendors.update',
    'vendors.approve',
    'vendors.suspend',
    'vendor_staff.view',
    'vendor_staff.create',
    'vendor_staff.update',
    'vendor_staff.delete',
    'vendor_documents.view',
    'vendor_documents.verify',
  ]),
  CATALOGUE_PROPOSALS: Object.freeze([
    'product_proposals.view',
    'product_proposals.create',
    'product_proposals.update',
    'product_proposals.approve',
    'product_proposals.reject',
  ]),
  PROCUREMENT: Object.freeze([
    'procurement.view',
    'procurement.create',
    'procurement.update',
    'procurement.cancel',
    'procurement.respond',
    'supply_batches.view',
    'supply_batches.create',
    'supply_batches.update',
    'supply_batches.ready',
    'supply_batches.dispatch',
    'supply_batches.handover',
    'batch_evidence.view',
    'batch_evidence.upload',
    'batch_evidence.moderate',
  ]),
  WAREHOUSE_OPERATIONS: Object.freeze([
    'warehouses.view',
    'warehouses.create',
    'warehouses.update',
    'warehouse_receipts.view',
    'warehouse_receipts.create',
    'warehouse_receipts.update',
    'warehouse_receipts.submit_qc',
    'quality_control.view',
    'quality_control.decide',
    'quality_control.override',
    'inventory_lots.view',
    'inventory_lots.adjust',
    'inventory_lots.transfer',
    'inventory_lots.recall',
    'inventory_ledger.view',
  ]),
  FULFILMENT_DELIVERY: Object.freeze([
    'fulfilment.view',
    'fulfilment.pick',
    'fulfilment.pack',
    'fulfilment.override',
    'delivery_tasks.assign',
    'delivery_tasks.update',
    'delivery_tasks.fail',
    'delivery_tasks.override',
    'riders.view',
    'riders.assign',
    'riders.approve',
  ]),
  CUSTOMER_SUPPORT: Object.freeze([
    'support_tickets.view',
    'support_tickets.update',
    'support_tickets.refund',
    'support_tickets.replace',
    'recalls.view',
    'recalls.create',
    'recalls.activate',
    'recalls.close',
  ]),
  MARKETING_LOYALTY: Object.freeze([
    'loyalty.view',
    'loyalty.configure',
    'loyalty.adjust',
    'loyalty.export',
    'shop_coupons.view',
    'shop_coupons.create',
    'shop_coupons.update',
    'shop_coupons.delete',
  ]),
  FINANCE_REPORTING: Object.freeze([
    'finance.global_view',
    'reports.global_view',
    'reports.quality_view',
    'reports.traceability_view',
    'shop_financials.view',
    'shop_financials.export',
    'shop_financials.mark_paid',
    'shop_transactions.view',
    'shop_transactions.export',
    'shop_reports.view',
    'audit_logs.view',
  ]),
})

/**
 * HQ_Role → permission set map (legacy preserved)
 */
export const HQ_ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: Object.freeze(new Set(ALL_PERMISSIONS)),
  ADMIN: Object.freeze(new Set(ALL_PERMISSIONS)),
  HQ_MANAGER: Object.freeze(
    new Set([
      'reports.global_view',
      'riders.assign',
      'riders.view',
      'shop_coupons.create',
      'shop_coupons.update',
      'shop_coupons.view',
      'shop_orders.assign_rider',
      'shop_orders.cancel',
      'shop_orders.export',
      'shop_orders.update_status',
      'shop_orders.view',
      'shop_products.approve',
      'shop_products.bulk_update',
      'shop_products.create',
      'shop_products.update',
      'shop_products.view',
      'shop_reports.view',
      'shop_staff.create',
      'shop_staff.reset_password',
      'shop_staff.update',
      'shop_staff.view',
      'shops.update',
      'shops.view',
    ]),
  ),
  HQ_FINANCE: Object.freeze(
    new Set([
      'audit_logs.view',
      'finance.global_view',
      'reports.global_view',
      'shop_financials.export',
      'shop_financials.mark_paid',
      'shop_financials.view',
      'shop_orders.export',
      'shop_orders.refund',
      'shop_orders.view',
      'shop_reports.view',
      'shop_transactions.export',
      'shop_transactions.view',
      'shops.view',
    ]),
  ),
  HQ_SUPPORT: Object.freeze(
    new Set([
      'riders.assign',
      'riders.view',
      'shop_coupons.view',
      'shop_orders.assign_rider',
      'shop_orders.cancel',
      'shop_orders.update_status',
      'shop_orders.view',
      'shop_products.view',
      'shop_reports.view',
      'shop_staff.view',
      'shops.view',
    ]),
  ),
})

/**
 * SHOP_* role → default permission set map (legacy preserved)
 */
export const SHOP_ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  SHOP_ADMIN: Object.freeze(new Set(SHOP_SCOPED_PERMISSIONS)),
  SHOP_MANAGER: Object.freeze(
    new Set(
      SHOP_SCOPED_PERMISSIONS.filter(
        (p) => p !== 'shop_staff.delete' && p !== 'shop_financials.mark_paid',
      ),
    ),
  ),
  SHOP_STAFF: Object.freeze(
    new Set([
      'shop_orders.view',
      'shop_orders.update_status',
      'shop_products.view',
      'shop_products.update',
    ]),
  ),
  SHOP_VIEWER: Object.freeze(
    new Set([
      'shops.view',
      'shop_products.view',
      'shop_orders.view',
      'shop_transactions.view',
      'shop_financials.view',
      'shop_reports.view',
    ]),
  ),
})

/**
 * Master Role → Permission mapping for all 17 system roles
 */
export const ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: Object.freeze(new Set(ALL_PERMISSIONS)),
  ADMIN: Object.freeze(new Set(ALL_PERMISSIONS)),
  HQ_MANAGER: HQ_ROLE_PERMISSIONS.HQ_MANAGER,
  SUPPORT_AGENT: Object.freeze(new Set(PERMISSION_GROUPS.CUSTOMER_SUPPORT.concat(['shop_orders.view', 'shops.view']))),
  FINANCE_USER: HQ_ROLE_PERMISSIONS.HQ_FINANCE,
  CONTENT_MANAGER: Object.freeze(new Set(PERMISSION_GROUPS.CATALOGUE_PROPOSALS.concat(['shop_products.approve', 'shop_products.bulk_update', 'shops.view']))),
  MARKETING_USER: Object.freeze(new Set(PERMISSION_GROUPS.MARKETING_LOYALTY.concat(['reports.global_view', 'auctions.view', 'auctions.manage', 'ads.view', 'ads.manage']))),
  READ_ONLY_ANALYST: Object.freeze(new Set(ALL_PERMISSIONS.filter((p) => p.endsWith('.view') || p.endsWith('.global_view') || p.endsWith('.export')))),
  VENDOR_OWNER: Object.freeze(new Set(PERMISSION_GROUPS.VENDORS.concat(PERMISSION_GROUPS.CATALOGUE_PROPOSALS, PERMISSION_GROUPS.PROCUREMENT, ['shop_products.create', 'shop_products.update', 'shop_orders.view']))),
  VENDOR_OPERATOR: Object.freeze(new Set(['product_proposals.create', 'product_proposals.update', 'procurement.respond', 'procurement.view', 'supply_batches.view', 'supply_batches.create', 'supply_batches.update', 'batch_evidence.upload', 'shop_products.view', 'shop_orders.view'])),
  WAREHOUSE_RECEIVER: Object.freeze(new Set(['warehouse_receipts.view', 'warehouse_receipts.create', 'warehouse_receipts.update', 'warehouse_receipts.submit_qc', 'warehouses.view', 'supply_batches.view'])),
  QUALITY_CONTROLLER: Object.freeze(new Set(['quality_control.view', 'quality_control.decide', 'quality_control.override', 'warehouse_receipts.view', 'supply_batches.view', 'batch_evidence.view'])),
  PICKER: Object.freeze(new Set(['fulfilment.view', 'fulfilment.pick', 'inventory_lots.view'])),
  PACKER: Object.freeze(new Set(['fulfilment.view', 'fulfilment.pack', 'inventory_lots.view'])),
  INVENTORY_MANAGER: Object.freeze(new Set(PERMISSION_GROUPS.WAREHOUSE_OPERATIONS)),
  RIDER: Object.freeze(new Set(['delivery_tasks.update', 'shop_orders.view', 'riders.view'])),
  CUSTOMER: Object.freeze(new Set(['shops.view', 'shop_products.view'])),
})

/**
 * Validate permission array against the 67-permission canonical vocabulary
 * @param {unknown} arr
 * @returns {string[]}
 */
export function assertValidPermissions(arr) {
  if (!Array.isArray(arr)) {
    const err = new Error('permissions must be an array')
    err.code = 'PERMISSION_INVALID'
    throw err
  }
  for (const perm of arr) {
    if (typeof perm !== 'string' || !PERMISSIONS.has(perm)) {
      const err = new Error(`Unknown permission string: ${perm}`)
      err.code = 'PERMISSION_INVALID'
      throw err
    }
  }
  return arr
}
