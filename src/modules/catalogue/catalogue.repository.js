/**
 * Catalogue Repository — Data Access Layer for Brands, Categories, and Proposals
 * Source of truth: Blueprint §06.2, Phase 3A
 *
 * @module modules/catalogue/catalogue.repository
 */

import { query } from '../../config/database.js'

export class CatalogueRepository {
  // ─── BRANDS ─────────────────────────────────────────
  async createBrand({ name, slug, logo_url = null, is_active = true }) {
    const { rows } = await query(
      `INSERT INTO brands (name, slug, logo_url, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, slug, logo_url, is_active]
    )
    return rows[0]
  }

  async findBrandById(id) {
    const { rows } = await query(`SELECT * FROM brands WHERE id = $1 LIMIT 1`, [id])
    return rows[0] || null
  }

  async listBrands() {
    const { rows } = await query(`SELECT * FROM brands WHERE is_active = true ORDER BY name ASC`)
    return rows
  }

  // ─── PROPOSALS ──────────────────────────────────────
  async findProposalDuplicateSku(vendorId, sku, excludeId = null) {
    if (!sku) return null
    const { rows } = await query(
      `SELECT id FROM product_proposals
        WHERE vendor_id = $1 AND sku = $2 AND ($3::uuid IS NULL OR id != $3) AND deleted_at IS NULL
        LIMIT 1`,
      [vendorId, sku, excludeId]
    )
    return rows[0] || null
  }

  async createProposal(vendorId, data) {
    const { title, slug, category_id = null, brand_id = null, sku = null, description = null, unit = 'kg', target_price = null, metadata = {} } = data
    const { rows } = await query(
      `INSERT INTO product_proposals (vendor_id, title, slug, category_id, brand_id, sku, description, unit, target_price, metadata, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT')
       RETURNING *`,
      [vendorId, title, slug, category_id, brand_id, sku, description, unit, target_price, JSON.stringify(metadata)]
    )
    return rows[0]
  }

  async findProposalById(id) {
    const { rows } = await query(
      `SELECT p.*, c.name AS category_name, b.name AS brand_name
         FROM product_proposals p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.id = $1 AND p.deleted_at IS NULL
        LIMIT 1`,
      [id]
    )
    return rows[0] || null
  }

  async updateProposal(id, updates) {
    const fields = []
    const params = [id]
    let idx = 2

    for (const key of ['title', 'slug', 'category_id', 'brand_id', 'sku', 'description', 'unit', 'target_price', 'status', 'metadata']) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = $${idx}`)
        params.push(key === 'metadata' ? JSON.stringify(updates[key]) : updates[key])
        idx++
      }
    }

    if (fields.length === 0) return this.findProposalById(id)

    const { rows } = await query(
      `UPDATE product_proposals SET ${fields.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    )
    return this.findProposalById(id)
  }

  async updateProposalStatus(id, newStatus) {
    const { rows } = await query(
      `UPDATE product_proposals SET status = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, newStatus]
    )
    return rows[0]
  }

  async logProposalReview({ proposalId, reviewerId = null, action, previousStatus, newStatus, comments = null }) {
    const { rows } = await query(
      `INSERT INTO product_proposal_reviews (proposal_id, reviewer_id, action, previous_status, new_status, comments)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [proposalId, reviewerId, action, previousStatus, newStatus, comments]
    )
    return rows[0]
  }

  async listProposals({ vendorId = null, status = null, search = '', page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const conditions = ['p.deleted_at IS NULL']
    const params = []
    let idx = 1

    if (vendorId) {
      conditions.push(`p.vendor_id = $${idx}`)
      params.push(vendorId)
      idx++
    }

    if (status) {
      conditions.push(`p.status = $${idx}`)
      params.push(status)
      idx++
    }

    if (search) {
      conditions.push(`(p.title ILIKE $${idx} OR p.sku ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }

    const whereClause = conditions.join(' AND ')

    const countRes = await query(`SELECT COUNT(*)::int AS total FROM product_proposals p WHERE ${whereClause}`, params)
    const total = countRes.rows[0]?.total || 0

    const dataRes = await query(
      `SELECT p.*, c.name AS category_name, b.name AS brand_name
         FROM product_proposals p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
        WHERE ${whereClause}
        ORDER BY p.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    return { data: dataRes.rows, total }
  }

  async createMasterProductFromProposal(proposal) {
    const { rows } = await query(
      `INSERT INTO products (name, slug, description, category_id, unit, price, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [proposal.title, proposal.slug, proposal.description, proposal.category_id, proposal.unit, proposal.target_price || 0]
    )
    return rows[0]
  }
}
