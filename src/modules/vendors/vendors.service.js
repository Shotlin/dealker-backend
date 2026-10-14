/**
 * Vendor Service — Business Logic Layer for Vendor Domain
 * Source of truth: Blueprint §06.1, Phase 2A
 *
 * @module modules/vendors/vendors.service
 */

import { ERROR_CODES } from '../../constants/errors.js'
import { logger } from '../../config/logger.js'

function generateSlug(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const PINCODE_RE = /^[1-9][0-9]{5}$/
const validation = (message) => Object.assign(new Error(message), { statusCode: 400, code: 'VALIDATION_ERROR' })

export class VendorsService {
  /**
   * @param {import('./vendors.repository.js').VendorsRepository} repository
   */
  constructor(repository) {
    this.repository = repository
  }

  /**
   * Create a new vendor
   * @param {object} data
   * @returns {Promise<object>}
   */
  async createVendor(data) {
    const slug = data.slug || generateSlug(data.name)

    // Check duplicate email or phone
    const duplicate = await this.repository.findDuplicate(data.email, data.phone)
    if (duplicate) {
      const err = new Error('Vendor with this email or phone already exists')
      err.statusCode = 409
      err.code = ERROR_CODES.DUPLICATE_ENTRY || 'DUPLICATE_VENDOR'
      throw err
    }

    const vendor = await this.repository.create({ ...data, slug })
    logger.info({ vendorId: vendor.id, name: vendor.name }, 'Vendor created successfully')
    return vendor
  }

  /**
   * Get vendor by ID
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getVendorById(id) {
    const vendor = await this.repository.findById(id)
    if (!vendor) {
      const err = new Error('Vendor not found')
      err.statusCode = 404
      err.code = 'VENDOR_NOT_FOUND'
      throw err
    }
    return vendor
  }

  /**
   * Update vendor details
   * @param {string} id
   * @param {object} data
   * @returns {Promise<object>}
   */
  async updateVendor(id, data, { asVendor = false } = {}) {
    await this.getVendorById(id)
    if (asVendor) {
      // A vendor may only change how they are reached; slug, activation and anything else is platform-controlled.
      data = Object.fromEntries(Object.entries(data).filter(([k]) => ['name', 'email', 'phone'].includes(k)))
      if (data.name !== undefined) data.name = String(data.name).trim()
      if (data.email !== undefined) data.email = String(data.email).trim().toLowerCase()
      if (data.name !== undefined && data.name.length < 2) throw validation('Store name must be at least 2 characters')
    }

    if (data.email || data.phone) {
      const duplicate = await this.repository.findDuplicate(data.email, data.phone, id)
      if (duplicate) {
        const err = new Error('Vendor with this email or phone already exists')
        err.statusCode = 409
        err.code = ERROR_CODES.DUPLICATE_ENTRY || 'DUPLICATE_VENDOR'
        throw err
      }
    }

    if (data.name && !data.slug && !asVendor) {
      data.slug = generateSlug(data.name)
    }

    const updated = await this.repository.update(id, data)
    logger.info({ vendorId: id }, 'Vendor updated successfully')
    return updated
  }

  /**
   * Transition vendor status (activation/suspension/verification)
   * @param {string} id
   * @param {string} status
   * @param {string} [reason]
   * @returns {Promise<object>}
   */
  async updateVendorStatus(id, status, reason) {
    const vendor = await this.getVendorById(id)

    const is_active = status !== 'SUSPENDED' && status !== 'DEACTIVATED'
    const updated = await this.repository.update(id, { status, is_active })

    logger.info({ vendorId: id, oldStatus: vendor.status, newStatus: status, reason }, 'Vendor status updated')
    return updated
  }

  /**
   * Soft delete vendor
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async deleteVendor(id) {
    await this.getVendorById(id)
    const success = await this.repository.softDelete(id)
    logger.info({ vendorId: id }, 'Vendor soft deleted')
    return success
  }

  /**
   * List and search vendors
   * @param {object} queryParams
   * @returns {Promise<{ data: Array, pagination: object }>}
   */
  async listVendors(queryParams) {
    const { page = 1, limit = 20, search, status, is_active } = queryParams
    const { data, total } = await this.repository.findMany({ page, limit, search, status, is_active })

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    }
  }

  /**
   * Update vendor profile
   * @param {string} vendorId
   * @param {object} profileData
   * @returns {Promise<object>}
   */
  async updateProfile(vendorId, profileData, { asVendor = false } = {}) {
    const vendor = await this.getVendorById(vendorId)
    const data = { ...profileData }
    const upper = (v) => String(v).trim().toUpperCase()
    if (data.gstin !== undefined) data.gstin = upper(data.gstin)
    if (data.pan_number !== undefined) data.pan_number = upper(data.pan_number)
    if (data.gstin && !GSTIN_RE.test(data.gstin)) throw validation('GSTIN must be 15 characters, like 29ABCDE1234F1Z5')
    if (data.pan_number && !PAN_RE.test(data.pan_number)) throw validation('PAN must look like ABCDE1234F')
    if (data.pincode && !PINCODE_RE.test(String(data.pincode).trim())) throw validation('Pincode must be 6 digits')
    for (const k of ['city', 'state', 'address_line1', 'address_line2', 'legal_name']) {
      if (data[k] !== undefined) data[k] = String(data[k]).trim()
    }
    if (asVendor) {
      // Identity details that KYC verified can only be changed through support; blanks can still be filled in.
      const verified = ['VERIFIED', 'ACTIVE'].includes(vendor.status)
      const locked = ['legal_name', 'gstin', 'pan_number', 'trade_license_number', 'fssai_license']
      for (const k of locked) {
        if (data[k] === undefined) continue
        const current = String(vendor.profile?.[k] ?? '').trim()
        if (verified && current && data[k] !== current) {
          const err = new Error('This detail was verified during KYC. Contact support to change it.')
          // 409 not 403: the global handler treats thrown 401/403 from non-Fastify errors as upstream faults (502).
          err.statusCode = 409
          err.code = 'PROFILE_LOCKED'
          err.field = k
          throw err
        }
      }
      delete data.metadata // internal flags are not vendor-editable
    }
    return this.repository.updateProfile(vendorId, data)
  }

  /**
   * Update vendor settings
   * @param {string} vendorId
   * @param {object} settingsData
   * @returns {Promise<object>}
   */
  async updateSettings(vendorId, settingsData) {
    await this.getVendorById(vendorId)
    return this.repository.updateSettings(vendorId, settingsData)
  }
}
