import { query } from '../../config/database.js'

const SELECT_COLUMNS = `
  id, name, slug, category_id, thumbnail_url, description,
  is_active, created_at, updated_at
`

export class ProductFamiliesRepository {
  async create(data) {
    const { rows } = await query(
      `INSERT INTO product_families (name, slug, category_id, thumbnail_url, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [
        data.name,
        data.slug,
        data.category_id || null,
        data.thumbnail_url || null,
        data.description || null,
        data.is_active !== false,
      ]
    )
    return rows[0]
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM product_families WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM product_families WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }

  async findMany({ page = 1, limit = 20, search, category_id, is_active }) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = []
    let paramIdx = 1

    if (search) {
      conditions.push(`name ILIKE $${paramIdx++}`)
      params.push(`%${search}%`)
    }

    if (category_id) {
      conditions.push(`category_id = $${paramIdx++}`)
      params.push(category_id)
    }

    if (is_active === 'true') {
      conditions.push('is_active = true')
    } else if (is_active === 'false') {
      conditions.push('is_active = false')
    }

    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1'

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${SELECT_COLUMNS}
         FROM product_families
         WHERE ${where}
         ORDER BY name ASC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM product_families WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const updatable = ['name', 'slug', 'category_id', 'thumbnail_url', 'description', 'is_active']
    for (const key of updatable) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (fields.length === 0) return this.findById(id)

    fields.push('updated_at = NOW()')
    params.push(id)

    const { rows } = await query(
      `UPDATE product_families SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING ${SELECT_COLUMNS}`,
      params
    )
    return rows[0] || null
  }

  async deactivate(id) {
    const { rows } = await query(
      `UPDATE product_families SET is_active = false, updated_at = NOW()
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id]
    )
    return rows[0] || null
  }

  async countProductsInFamily(familyId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
       FROM products
       WHERE product_family_id = $1 AND is_active = true`,
      [familyId]
    )
    return rows[0]?.count || 0
  }

  /**
   * Admin-only: list every product belonging to a family (active or
   * inactive). Returns all the option-display fields the dashboard needs
   * for the Family Detail page's options table. Soft-deleted families
   * still surface their attached products so admins can clean up.
   *
   * @param {string} familyId
   * @returns {Promise<Array<object>>}
   */
  async findOptionsByFamilyId(familyId) {
    const { rows } = await query(
      `SELECT
         p.id, p.name, p.slug, p.thumbnail_url,
         p.price, p.sale_price, p.stock_quantity, p.unit,
         p.is_active, p.option_label, p.option_sort_order,
         p.is_default_option, p.food_type, p.origin_tag,
         p.custom_badges, p.display_delivery_minutes,
         p.cut_type, p.piece_count, p.skin_type,
         p.product_family_id, p.category_id,
         c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.product_family_id = $1
       ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.name ASC`,
      [familyId]
    )
    return rows
  }
}
