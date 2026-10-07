/**
 * Proposal Media Repository — Data Access Layer for Proposal Media, Variants & Specs
 * Source of truth: Blueprint §06.2, Phase 3B
 *
 * @module modules/catalogue/proposal-media.repository
 */

import { query } from '../../config/database.js'

export class ProposalMediaRepository {
  // ─── MEDIA ──────────────────────────────────────────
  async unsetPrimaryImage(proposalId) {
    await query(`UPDATE product_proposal_media SET is_primary = false WHERE proposal_id = $1`, [proposalId])
  }

  async addMedia(proposalId, data) {
    const { media_type, file_key, file_url = null, mime_type = null, size = null, sort_order = 0, is_primary = false } = data

    if (is_primary) {
      await this.unsetPrimaryImage(proposalId)
    }

    const { rows } = await query(
      `INSERT INTO product_proposal_media (proposal_id, media_type, file_key, file_url, mime_type, size, sort_order, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [proposalId, media_type, file_key, file_url, mime_type, size, sort_order, is_primary]
    )
    return rows[0]
  }

  async getProposalMedia(proposalId) {
    const { rows } = await query(
      `SELECT * FROM product_proposal_media WHERE proposal_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [proposalId]
    )
    return rows
  }

  async deleteMedia(mediaId) {
    const { rowCount } = await query(`DELETE FROM product_proposal_media WHERE id = $1`, [mediaId])
    return rowCount > 0
  }

  // ─── VARIANTS ───────────────────────────────────────
  async findDuplicateVariant(proposalId, sku, attributes = {}) {
    const { rows } = await query(
      `SELECT id FROM product_proposal_variants
        WHERE proposal_id = $1 AND (sku = $2 OR attributes = $3::jsonb)
        LIMIT 1`,
      [proposalId, sku, JSON.stringify(attributes)]
    )
    return rows[0] || null
  }

  async addVariant(proposalId, data) {
    const { sku, name, target_price = null, attributes = {} } = data
    const { rows } = await query(
      `INSERT INTO product_proposal_variants (proposal_id, sku, name, target_price, attributes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [proposalId, sku, name, target_price, JSON.stringify(attributes)]
    )
    return rows[0]
  }

  async getProposalVariants(proposalId) {
    const { rows } = await query(
      `SELECT * FROM product_proposal_variants WHERE proposal_id = $1 ORDER BY created_at ASC`,
      [proposalId]
    )
    return rows
  }

  // ─── SPECIFICATIONS ─────────────────────────────────
  async addSpecification(proposalId, data) {
    const { key, value, group_name = 'General' } = data
    const { rows } = await query(
      `INSERT INTO product_proposal_specifications (proposal_id, key, value, group_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (proposal_id, key) DO UPDATE SET value = EXCLUDED.value, group_name = EXCLUDED.group_name
       RETURNING *`,
      [proposalId, key, value, group_name]
    )
    return rows[0]
  }

  async getProposalSpecifications(proposalId) {
    const { rows } = await query(
      `SELECT * FROM product_proposal_specifications WHERE proposal_id = $1 ORDER BY group_name ASC, key ASC`,
      [proposalId]
    )
    return rows
  }
}
