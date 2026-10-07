import { logger } from '../../config/logger.js'
import { query } from '../../config/database.js'
import { env } from '../../config/env.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'
import { PincodeMappingsRepository } from '../pincode-mappings/pincode-mappings.repository.js'
import { FeeSettingsRepository } from '../fee-settings/fee-settings.repository.js'
import { cleanPincode } from '../../utils/pincode.js'
import {
  getCachedServiceablePincodes,
  setCachedServiceablePincodes,
} from '../../utils/serviceable-pincode-cache.js'

// Fallback ETA used only if fee_settings has no GLOBAL row yet or the
// lookup errors — keeps validate-pincode working exactly as before this
// became dashboard-configurable (Settings -> Delivery Timer).
const FALLBACK_ETA_MINUTES = 30

const MAX_ADDRESSES = 10

// How long a soft-deleted address is kept before the purge cron
// permanently removes it (security/dispute-review window — see
// `AddressPurgeWorker`). Shared with the admin customer-addresses view so
// the "removed, purges in N days" countdown always matches reality.
export const ADDRESS_RETENTION_DAYS = 40

// ─── Serviceable pincodes — aggregated from active shops ─────────────
// The old implementation read from app_settings (a global static list),
// which missed pincodes added to individual shops. This version queries
// the shops table directly so any pincode in any active shop's
// serviceable_pincodes array is immediately available to customers.
// Cached for 5 minutes in-process (src/utils/serviceable-pincode-cache.js);
// ShopsService drops that cache whenever a shop's service area changes.
// Stored entries are whitespace-stripped on read too, so rows written before
// PIN normalisation existed still match.
async function getServiceablePincodes() {
  const cached = getCachedServiceablePincodes()
  if (cached !== undefined) return cached

  try {
    // Flatten all serviceable_pincodes arrays from every active, non-deleted shop
    const { rows } = await query(
      `SELECT DISTINCT unnest(serviceable_pincodes) AS pincode
         FROM shops
        WHERE is_active = true
          AND deleted_at IS NULL
          AND array_length(serviceable_pincodes, 1) > 0`
    )

    const pincodes = new Set(
      rows.map((r) => cleanPincode(r.pincode)).filter(Boolean)
    )
    // No shops configured yet — allow all pincodes so the app isn't blocked
    const value = pincodes.size > 0 ? pincodes : null

    // Only a real PIN set is cached. The "allow all" result (null) is
    // re-queried every call, exactly as before, so the first shop that gets
    // a PIN configured takes effect immediately.
    if (value) setCachedServiceablePincodes(value)
    logger.info(
      { count: value ? value.size : 'all' },
      'Serviceable pincodes loaded from active shops'
    )
    return value
  } catch (err) {
    logger.error({ err }, 'Failed to load serviceable pincodes from shops — allowing all')
    return null // null = allow all, so the app never gets stuck
  }
}

/**
 * Addresses service — business logic for delivery addresses
 */
export class AddressesService {
  constructor(repository, options = {}) {
    this.repo = repository
    // Hard serviceability gate at save time — separate from the
    // fire-and-forget allocation recompute below, which only populates
    // user_shop_allocations for cart/catalog scoping and never blocks
    // anything. Injectable for tests.
    this.allocationRepo = options.allocationRepository || new AllocationRepository()
    // Admin-curated pincode -> city/area/state overrides (see migration 089)
    // and the dashboard-configurable delivery ETA (fee_settings.delivery_eta_minutes,
    // Settings -> Delivery Timer) — both surfaced through validatePincode().
    this.pincodeMappingsRepo = options.pincodeMappingsRepository || new PincodeMappingsRepository()
    this.feeSettingsRepo = options.feeSettingsRepository || new FeeSettingsRepository()
  }

  /**
   * Get all addresses for a user
   */
  async list(userId) {
    return this.repo.findByUser(userId)
  }

  /**
   * Create a new address
   */
  async create(userId, data) {
    if (!this._hasValidCoordinates(data.lat, data.lng)) {
      return {
        success: false,
        message: 'Map pin is required. Please select your exact location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }

    // Hard-block an address outside every active shop's declared service
    // area (pincode list OR delivery radius) — previously the only check
    // was a separate, client-invoked /validate-pincode endpoint the
    // mobile UI called for a soft warning; the actual save was never
    // gated by it, so any pincode/location could be saved regardless.
    const serviceable = await this.allocationRepo.isServiceable({
      pincode: data.pincode,
      lat: data.lat,
      lng: data.lng,
    })
    if (!serviceable) {
      return {
        success: false,
        message: 'Delivery is not available at this address yet.',
        code: 'ADDRESS_NOT_SERVICEABLE',
      }
    }

    const count = await this.repo.countByUser(userId)
    if (count >= MAX_ADDRESSES) {
      return { success: false, message: `Maximum ${MAX_ADDRESSES} addresses allowed` }
    }

    // First address or explicitly default
    if (data.isDefault || count === 0) {
      data.isDefault = true
    }

    const address = await this.repo.create(userId, data)

    // If set as default, unset others
    if (data.isDefault && count > 0) {
      await this.repo.setDefault(address.id, userId)
    }

    logger.info({ userId, addressId: address.id }, 'Address created')

    // FIX: Automatically recompute shop allocation when an address is created.
    // This ensures that a real user who adds their first delivery address
    // immediately gets an allocated shop and can view product details.
    // Fire-and-forget — do not block the address creation response.
    if (this._hasValidCoordinates(data.lat, data.lng) && data.pincode) {
      setImmediate(() => {
        this._triggerAllocationRecompute(userId, {
          lat: Number(data.lat),
          lng: Number(data.lng),
          pincode: String(data.pincode),
        }).catch((err) => {
          logger.warn(
            { userId, err: err.message, action: 'address_create.allocation_recompute_failed' },
            'Background allocation recompute failed after address creation'
          )
        })
      })
    }

    return { success: true, address }
  }

  /**
   * Update an address
   */
  async update(userId, id, data) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    const hasLat = Object.prototype.hasOwnProperty.call(data, 'lat')
    const hasLng = Object.prototype.hasOwnProperty.call(data, 'lng')
    if (hasLat !== hasLng) {
      return {
        success: false,
        message: 'Latitude and longitude must be updated together.',
        code: 'ADDRESS_COORDINATES_INCOMPLETE',
      }
    }
    if (hasLat && !this._hasValidCoordinates(data.lat, data.lng)) {
      return {
        success: false,
        message: 'Map pin is invalid. Please select your location again.',
        code: 'ADDRESS_COORDINATES_INVALID',
      }
    }
    if (!hasLat && !this._hasValidCoordinates(existing.lat, existing.lng)) {
      return {
        success: false,
        message: 'Map pin is required. Please update this address location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }

    // Effective post-update values — computed here (moved up from after
    // the DB write) so the serviceability gate below can see them before
    // anything is saved. Falls back to the existing row's values for
    // whichever field wasn't part of this update.
    const effectiveLat = hasLat ? Number(data.lat) : Number(existing.lat)
    const effectiveLng = hasLng ? Number(data.lng) : Number(existing.lng)
    const effectivePincode = data.pincode ?? existing.pincode

    // Hard-block moving an address outside every active shop's service
    // area — only re-checked when the location actually changed (new
    // coordinates or a different pincode); an unrelated edit (e.g.
    // renaming the label) on an already-saved address must never be
    // retroactively blocked by this gate.
    const locationChanged =
      hasLat || (data.pincode !== undefined && data.pincode !== existing.pincode)
    if (locationChanged) {
      const serviceable = await this.allocationRepo.isServiceable({
        pincode: effectivePincode,
        lat: effectiveLat,
        lng: effectiveLng,
      })
      if (!serviceable) {
        return {
          success: false,
          message: 'Delivery is not available at this address yet.',
          code: 'ADDRESS_NOT_SERVICEABLE',
        }
      }
    }

    const address = await this.repo.update(id, userId, data)
    logger.info({ userId, addressId: id }, 'Address updated')

    // FIX: Recompute allocation when a default address coordinates/pincode change.
    // Use updated coords if provided, fall back to existing.
    if (
      this._hasValidCoordinates(effectiveLat, effectiveLng) &&
      effectivePincode
    ) {
      setImmediate(() => {
        this._triggerAllocationRecompute(userId, {
          lat: effectiveLat,
          lng: effectiveLng,
          pincode: String(effectivePincode),
        }).catch((err) => {
          logger.warn(
            { userId, err: err.message, action: 'address_update.allocation_recompute_failed' },
            'Background allocation recompute failed after address update'
          )
        })
      })
    }

    return { success: true, address }
  }

  /**
   * Delete an address
   */
  async delete(userId, id) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    await this.repo.delete(id, userId)

    // If deleted the default, promote newest remaining
    if (existing.isDefault) {
      const remaining = await this.repo.findByUser(userId)
      if (remaining.length > 0) {
        const promoted = remaining[0]
        await this.repo.setDefault(promoted.id, userId)
        // FIX: the promoted address is now the delivery context — recompute
        // allocation so cart/product availability tracks the new default.
        this._recomputeForAddress(userId, promoted, 'address_delete')
      }
    }

    logger.info({ userId, addressId: id }, 'Address deleted')
    return { success: true }
  }

  /**
   * Set as default address
   */
  async setDefault(userId, id) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    const address = await this.repo.setDefault(id, userId)
    logger.info({ userId, addressId: id }, 'Default address set')

    // FIX (root cause of stale allocation): switching the default delivery
    // address must recompute the user's shop allocation. Previously only
    // create/update recomputed, so selecting an existing address as default
    // left the allocation pointing at the OLD address's shops — making
    // products from the new area's stores appear yet fail cart validation.
    this._recomputeForAddress(userId, address ?? existing, 'address_set_default')

    return { success: true, address }
  }

  /**
   * Validate pincode for delivery availability.
   * Checks against pincodes in active shops' serviceable_pincodes arrays.
   * Returns available=true also when no shops are configured yet (null set).
   *
   * Also attaches an admin-curated city/area/state override when an ACTIVE
   * pincode_mappings row matches (see migration 089) — the Flutter address
   * form uses this to auto-fill City instead of trusting the public
   * reverse-geocoder, which is unreliable for several rural/small-town
   * pincodes (e.g. parts of Gujarat resolving to the wrong city).
   *
   * Optional [lat]/[lng] (the map pin the Add Address screen already has
   * selected at this point) let a pincode the plain list check rejects
   * still be accepted when it falls inside a shop's delivery radius —
   * mirroring AllocationRepository#isServiceable, the same pincode-OR-radius
   * rule the actual address save (create/update below) and shop allocation
   * already enforce. Without this, an address genuinely served by radius
   * (not its literal pincode) showed "Delivery is not available at this pin
   * yet." on this live-typing check even though saving that exact address
   * would have succeeded — this screen's own check was stricter than what
   * it was previewing. Purely additive: a caller that omits lat/lng (there
   * are others — see location_prompt_provider.dart#pinServed) gets the
   * exact same pincode-list-only behavior as before.
   */
  async validatePincode(pincode, lat, lng) {
    const [etaMinutes, mapping] = await Promise.all([
      this._resolveEtaMinutes(),
      this.pincodeMappingsRepo.findActiveByPincode(pincode).catch((err) => {
        logger.warn({ err, pincode }, 'Pincode mapping lookup failed — continuing without override')
        return null
      }),
    ])
    const mappingFields = mapping
      ? { city: mapping.city, area: mapping.area, state: mapping.state }
      : {}

    if (env.ALLOW_ALL_PINCODES) {
      return { available: true, deliveryFee: 29, estimatedMin: etaMinutes, ...mappingFields }
    }

    const serviceablePincodes = await getServiceablePincodes()

    // null means no shops configured — allow all so the app isn't blocked.
    // The queried PIN is normalised the same way stored PINs are.
    let available =
      serviceablePincodes === null ||
      serviceablePincodes.has(cleanPincode(pincode))

    if (!available && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
      available = await this.allocationRepo.isServiceable({
        pincode,
        lat: Number(lat),
        lng: Number(lng),
      })
    }

    return {
      available,
      deliveryFee: available ? 29 : 0,
      estimatedMin: available ? etaMinutes : 0,
      ...mappingFields,
    }
  }

  /**
   * Reads the admin-configured delivery ETA from fee_settings' GLOBAL row
   * (dashboard: Settings -> Delivery Timer). Falls back to the previous
   * hardcoded value if the row is missing or the lookup errors, so this
   * never becomes a new way for validate-pincode to break.
   * @private
   */
  async _resolveEtaMinutes() {
    try {
      const global = await this.feeSettingsRepo.getGlobal()
      const minutes = Number(global?.delivery_eta_minutes)
      return Number.isFinite(minutes) && minutes > 0 ? minutes : FALLBACK_ETA_MINUTES
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve delivery ETA from fee settings — using fallback')
      return FALLBACK_ETA_MINUTES
    }
  }

  _hasValidCoordinates(lat, lng) {
    const parsedLat = Number(lat)
    const parsedLng = Number(lng)
    return Number.isFinite(parsedLat) &&
      Number.isFinite(parsedLng) &&
      parsedLat >= -90 &&
      parsedLat <= 90 &&
      parsedLng >= -180 &&
      parsedLng <= 180
  }

  /**
   * Fire-and-forget allocation recompute for a full address row (used by
   * setDefault/delete where we already hold the address record). Validates
   * coordinates + pincode before triggering so we never push an invalid
   * recompute.
   * @private
   */
  _recomputeForAddress(userId, address, action) {
    if (!address) return
    const lat = Number(address.lat)
    const lng = Number(address.lng)
    const pincode = address.pincode
    if (!this._hasValidCoordinates(lat, lng) || !pincode) {
      return
    }
    setImmediate(() => {
      this._triggerAllocationRecompute(userId, {
        lat,
        lng,
        pincode: String(pincode),
      }).catch((err) => {
        logger.warn(
          { userId, err: err.message, action: `${action}.allocation_recompute_failed` },
          'Background allocation recompute failed'
        )
      })
    })
  }

  /**
   * Fire-and-forget allocation recompute helper.
   * Called after address create/update so the user gets a shop allocation
   * automatically without needing to call POST /allocation/recompute manually.
   * @private
   */
  async _triggerAllocationRecompute(userId, address) {
    const allocationService = new AllocationService(new AllocationRepository())
    const result = await allocationService.computeAndUpsertForUser(userId, address)
    if (result.success) {
      logger.info(
        {
          userId,
          shopCount: result.data?.shops?.length ?? 0,
          action: 'address.allocation_recomputed',
        },
        'Allocation auto-recomputed after address change'
      )
    } else {
      logger.warn(
        { userId, code: result.code, message: result.message, action: 'address.allocation_recompute_failed' },
        'Allocation auto-recompute returned non-success'
      )
    }
  }
}
