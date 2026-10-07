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
  async updateVendor(id, data) {
    await this.getVendorById(id)

    if (data.email || data.phone) {
      const duplicate = await this.repository.findDuplicate(data.email, data.phone, id)
      if (duplicate) {
        const err = new Error('Vendor with this email or phone already exists')
        err.statusCode = 409
        err.code = ERROR_CODES.DUPLICATE_ENTRY || 'DUPLICATE_VENDOR'
        throw err
      }
    }

    if (data.name && !data.slug) {
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
  async updateProfile(vendorId, profileData) {
    await this.getVendorById(vendorId)
    return this.repository.updateProfile(vendorId, profileData)
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
