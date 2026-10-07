/**
 * Object-Level Authorization Policy Engine
 *
 * Enforces resource ownership and tenant scope constraints per:
 * - Specification §6.4 (Object authorization examples)
 * - Specification §7.3.2 (WP-03 Required code changes)
 * - Specification §11.46.2 (Security Architecture — Authorization)
 *
 * Acceptance Criteria satisfied:
 * - Vendor A receives 403 when requesting Vendor B resources (§7.3.3)
 * - Warehouse A receives 403 for Warehouse B resources (§7.3.3)
 * - Customer A receives 403/404 for Customer B resources (§7.3.3)
 *
 * @module core/permissions/object-policy
 */

import { ERROR_CODES, HTTP_STATUS } from '../../constants/errors.js'

/**
 * Creates a standardized 403 Forbidden Error for object policy failure.
 *
 * @param {string} message
 * @param {string} code
 * @returns {Error}
 */
function createPolicyError(message = 'Cross-tenant or object ownership violation', code = ERROR_CODES.CROSS_SCOPE_ACCESS_DENIED) {
  const err = new Error(message)
  err.statusCode = HTTP_STATUS.FORBIDDEN || 403
  err.code = code
  return err
}

/**
 * Assert customer resource ownership (Spec §6.4: orders.customer_id === principal.userId).
 *
 * @param {string} principalUserId - The authenticated user's ID
 * @param {string} targetCustomerId - The customer ID owning the resource
 * @param {boolean} [isPlatformUser=false] - Whether the principal is an admin/HQ user
 */
export function assertCustomerResource(principalUserId, targetCustomerId, isPlatformUser = false) {
  if (isPlatformUser) return true
  if (!principalUserId || !targetCustomerId || String(principalUserId) !== String(targetCustomerId)) {
    throw createPolicyError('Unauthorized access to customer resource', 'CUSTOMER_RESOURCE_ACCESS_DENIED')
  }
  return true
}

/**
 * Assert vendor resource tenant scope (Spec §6.4: supply_batches.vendor_id === principal.vendorId).
 *
 * @param {string} principalVendorId - The authenticated vendor scope ID
 * @param {string} targetVendorId - The vendor ID owning the resource
 * @param {boolean} [isPlatformUser=false] - Whether the principal is an admin/HQ user
 */
export function assertVendorResource(principalVendorId, targetVendorId, isPlatformUser = false) {
  if (isPlatformUser) return true
  if (!principalVendorId || !targetVendorId || String(principalVendorId) !== String(targetVendorId)) {
    throw createPolicyError('Unauthorized cross-vendor resource access', ERROR_CODES.CROSS_SCOPE_ACCESS_DENIED)
  }
  return true
}

/**
 * Assert warehouse resource tenant scope (Spec §6.4: warehouse_receipts.warehouse_id === principal.warehouseId).
 *
 * @param {string} principalWarehouseId - The authenticated warehouse scope ID
 * @param {string} targetWarehouseId - The warehouse ID owning the resource
 * @param {boolean} [isPlatformUser=false] - Whether the principal is an admin/HQ user
 */
export function assertWarehouseResource(principalWarehouseId, targetWarehouseId, isPlatformUser = false) {
  if (isPlatformUser) return true
  if (!principalWarehouseId || !targetWarehouseId || String(principalWarehouseId) !== String(targetWarehouseId)) {
    throw createPolicyError('Unauthorized cross-warehouse resource access', 'CROSS_WAREHOUSE_ACCESS_DENIED')
  }
  return true
}

/**
 * Assert rider resource assignment (Spec §6.4: active assignment belongs to rider profile linked to principal).
 *
 * @param {string} principalRiderId - The authenticated rider profile ID
 * @param {string} targetRiderId - The rider ID assigned to the delivery task
 * @param {boolean} [isPlatformUser=false] - Whether the principal is an admin/HQ user
 */
export function assertRiderResource(principalRiderId, targetRiderId, isPlatformUser = false) {
  if (isPlatformUser) return true
  if (!principalRiderId || !targetRiderId || String(principalRiderId) !== String(targetRiderId)) {
    throw createPolicyError('Delivery task is not assigned to this rider', 'DELIVERY_TASK_NOT_ASSIGNED')
  }
  return true
}
