/**
 * Vendor Eligibility Resolver — pure targeting logic for procurement publish
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §5
 *
 * Decides which vendors become persisted recipients when a store publishes a
 * procurement request. This module is intentionally PURE (no SQL, no I/O) so
 * targeting rules are unit-testable without HTTP or database.
 *
 * Big Phase 6 extension points (kept forward-compatible):
 *   - Category matching: vendors carry `categories` (array of category UUIDs)
 *     once the vendor service-category model lands. When absent the vendor is
 *     treated as "categories unknown" and passes, with the gap recorded in the
 *     persisted eligibility snapshot.
 *   - Area matching: vendors carry `service_pincodes` (array of 6-digit
 *     strings) once the service-area model lands. When absent the vendor's
 *     profile city/pincode equality with the shop is used as a weak fallback,
 *     again recorded in the snapshot.
 *
 * @module modules/vendor-procurement/vendor-eligibility
 */

const REQUIRED_VENDOR_STATUSES = new Set(['ACTIVE'])

/**
 * @param {object} vendor - vendor row (+ profile and membership flags)
 * @param {string} vendor.id
 * @param {string} vendor.status - vendors.status lifecycle value
 * @param {boolean} [vendor.is_active=true]
 * @param {boolean} [vendor.has_active_user=false] - vendor has an active vendor_users member
 * @param {boolean} [vendor.assigned_to_shop=false] - explicit vendor_store_assignments row for this shop
 * @param {string[]} [vendor.categories] - supplied category UUIDs (may be undefined)
 * @param {string[]} [vendor.service_pincodes] - serviced pincodes (may be undefined)
 * @param {string} [vendor.profile_pincode]
 * @param {string} [vendor.profile_city]
 * @param {object} shop - shop row the request belongs to
 * @param {string} [shop.pincode]
 * @param {string[]} [shop.serviceable_pincodes]
 * @param {string} [shop.city]
 * @param {object} request - request header (mode/deadline already validated upstream)
 * @param {Array<{category_id: string}>} items - request items
 * @returns {{ eligible: boolean, eligibility: object }} eligibility snapshot persisted on the recipient
 */
export function evaluateVendorEligibility(vendor, shop, request, items = []) {
  const checks = {
    vendor_status: REQUIRED_VENDOR_STATUSES.has(vendor.status) && vendor.is_active !== false,
    has_active_user: vendor.has_active_user === true,
    category_match: true,
    area_match: true,
  }

  const eligibility = {
    shop_pincode: shop?.pincode ?? null,
    shop_serviceable_pincodes: shop?.serviceable_pincodes ?? [],
    matched_categories: [],
    categories_unavailable: false,
    matched_pincodes: [],
    service_pincodes_unavailable: false,
    checks,
  }

  // ── Category targeting ─────────────────────────────────────────
  const requestedCategoryIds = [...new Set(items.map((i) => i.category_id).filter(Boolean))]
  if (Array.isArray(vendor.categories) && vendor.categories.length > 0) {
    eligibility.matched_categories = requestedCategoryIds.filter((id) => vendor.categories.includes(id))
    checks.category_match = eligibility.matched_categories.length > 0
  } else {
    eligibility.categories_unavailable = true
  }

  // ── Area targeting (store-first) ───────────────────────────────
  const shopPincodes = new Set(
    [
      ...(Array.isArray(shop?.serviceable_pincodes) ? shop.serviceable_pincodes : []),
      shop?.pincode,
    ].filter(Boolean)
  )
  if (vendor.assigned_to_shop === true) {
    // Explicit assignment: the store asked for this vendor by name.
    checks.area_match = true
    eligibility.matched_pincodes = ['STORE_ASSIGNMENT']
  } else if (Array.isArray(vendor.service_pincodes) && vendor.service_pincodes.length > 0) {
    eligibility.matched_pincodes = [...shopPincodes].filter((pin) => vendor.service_pincodes.includes(pin))
    checks.area_match = eligibility.matched_pincodes.length > 0
  } else if (vendor.profile_pincode || vendor.profile_city) {
    // Weak fallback until the service-area model exists (Phase 6):
    // a vendor whose registered profile is in the store's city passes.
    checks.area_match =
      (vendor.profile_pincode && shopPincodes.has(vendor.profile_pincode)) ||
      (vendor.profile_city && shop.city && vendor.profile_city === shop.city)
    if (checks.area_match && vendor.profile_pincode && shopPincodes.has(vendor.profile_pincode)) {
      eligibility.matched_pincodes = [vendor.profile_pincode]
    }
    eligibility.service_pincodes_unavailable = true
  } else {
    eligibility.service_pincodes_unavailable = true
  }

  const eligible = Object.values(checks).every(Boolean)
  return { eligible, eligibility }
}

/**
 * Filters a vendor candidate list down to eligible recipients.
 *
 * @param {object[]} vendors
 * @param {object} shop
 * @param {object} request
 * @param {Array<{category_id: string}>} items
 * @returns {{ recipients: object[], rejected: object[] }} recipients carry the
 *   persisted eligibility snapshot in `.eligibility`
 */
export function resolveEligibleVendors(vendors, shop, request, items = []) {
  const recipients = []
  const rejected = []
  for (const vendor of vendors) {
    const { eligible, eligibility } = evaluateVendorEligibility(vendor, shop, request, items)
    if (eligible) {
      recipients.push({ vendorId: vendor.id, eligibility })
    } else {
      rejected.push({ vendorId: vendor.id, eligibility })
    }
  }
  return { recipients, rejected }
}
