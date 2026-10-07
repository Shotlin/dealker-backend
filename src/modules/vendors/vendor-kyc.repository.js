/**
 * Vendor KYC Repository — Data Access Layer for Vendor KYC & Documents
 * Source of truth: Blueprint §06.1, Phase 2B
 *
 * @module modules/vendors/vendor-kyc.repository
 */

import { query } from '../../config/database.js'

export class VendorKycRepository {
  /**
   * Save or replace vendor document metadata
   * @param {string} vendorId
   * @param {object} docData
   * @returns {Promise<object>}
   */
  async saveDocument(vendorId, docData) {
    const { document_type, document_number = null, file_key, file_url = null } = docData
    const { rows } = await query(
      `INSERT INTO vendor_documents (vendor_id, document_type, document_number, file_key, file_url, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       RETURNING *`,
      [vendorId, document_type, document_number, file_key, file_url]
    )
    return rows[0]
  }

  /**
   * Get all documents for vendor
   * @param {string} vendorId
   * @returns {Promise<Array>}
   */
  async getVendorDocuments(vendorId) {
    const { rows } = await query(
      `SELECT * FROM vendor_documents WHERE vendor_id = $1 ORDER BY created_at DESC`,
      [vendorId]
    )
    return rows
  }

  /**
   * Log KYC review action to history
   * @param {object} reviewData
   * @returns {Promise<object>}
   */
  async logReview(reviewData) {
    const { vendor_id, reviewer_id = null, action, previous_status, new_status, comments = null } = reviewData
    const { rows } = await query(
      `INSERT INTO vendor_kyc_reviews (vendor_id, reviewer_id, action, previous_status, new_status, comments)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [vendor_id, reviewer_id, action, previous_status, new_status, comments]
    )
    return rows[0]
  }

  /**
   * Get review history for vendor
   * @param {string} vendorId
   * @returns {Promise<Array>}
   */
  async getReviewHistory(vendorId) {
    const { rows } = await query(
      `SELECT r.*, u.email AS reviewer_email
         FROM vendor_kyc_reviews r
         LEFT JOIN users u ON u.id = r.reviewer_id
        WHERE r.vendor_id = $1
        ORDER BY r.created_at DESC`,
      [vendorId]
    )
    return rows
  }

  /**
   * Update vendor status
   * @param {string} vendorId
   * @param {string} newStatus
   * @returns {Promise<object>}
   */
  async updateVendorStatus(vendorId, newStatus) {
    const is_active = newStatus === 'VERIFIED' || newStatus === 'ACTIVE'
    const { rows } = await query(
      `UPDATE vendors SET status = $2, is_active = $3 WHERE id = $1 RETURNING *`,
      [vendorId, newStatus, is_active]
    )
    return rows[0]
  }
}
