import { query } from '../../config/database.js'

export class ThemeTabsRepository {
  async findAll({ storeKey, status }) {
    const conditions = []
    const params = []
    let idx = 1

    if (storeKey) {
      conditions.push(`tab.store_key = $${idx++}`)
      params.push(storeKey)
    }

    if (status) {
      conditions.push(`tab.status = $${idx++}`)
      params.push(status)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT
         tab.*,
         theme_a.id AS theme_a_id,
         theme_a.name AS theme_a_name,
         theme_a.status AS theme_a_status,
         theme_a.updated_at AS theme_a_updated_at,
         theme_b.id AS theme_b_id,
         theme_b.name AS theme_b_name,
         theme_b.status AS theme_b_status,
         theme_b.updated_at AS theme_b_updated_at
       FROM theme_tabs tab
       LEFT JOIN LATERAL (
         SELECT id, name, status, updated_at
         FROM app_themes
         WHERE tab_id = tab.id
           AND ab_variant = 'A'
         ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC
         LIMIT 1
       ) theme_a ON true
       LEFT JOIN LATERAL (
         SELECT id, name, status, updated_at
         FROM app_themes
         WHERE tab_id = tab.id
           AND ab_variant = 'B'
         ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC
         LIMIT 1
       ) theme_b ON true
       ${where}
       ORDER BY tab.store_key ASC, tab.sort_order ASC, tab.label ASC`,
      params
    )

    return rows
  }

  async findById(id) {
    const { rows: [tab] } = await query(
      `SELECT
         tab.*,
         theme_a.id AS theme_a_id,
         theme_a.name AS theme_a_name,
         theme_a.status AS theme_a_status,
         theme_a.updated_at AS theme_a_updated_at,
         theme_b.id AS theme_b_id,
         theme_b.name AS theme_b_name,
         theme_b.status AS theme_b_status,
         theme_b.updated_at AS theme_b_updated_at
       FROM theme_tabs tab
       LEFT JOIN LATERAL (
         SELECT id, name, status, updated_at
         FROM app_themes
         WHERE tab_id = tab.id
           AND ab_variant = 'A'
         ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC
         LIMIT 1
       ) theme_a ON true
       LEFT JOIN LATERAL (
         SELECT id, name, status, updated_at
         FROM app_themes
         WHERE tab_id = tab.id
           AND ab_variant = 'B'
         ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC
         LIMIT 1
       ) theme_b ON true
       WHERE tab.id = $1`,
      [id]
    )
    return tab || null
  }

  async findByStoreAndKey(storeKey, key, { activeOnly = false } = {}) {
    const { rows: [tab] } = await query(
      `SELECT * FROM theme_tabs
       WHERE store_key = $1 AND key = $2
       ${activeOnly ? "AND status = 'active'" : ''}
       LIMIT 1`,
      [storeKey, key]
    )
    return tab || null
  }

  async create(data) {
    const { rows: [tab] } = await query(
       `INSERT INTO theme_tabs (
         store_key,
         key,
         label,
         image_url,
         text_color,
         sort_order,
         status,
         is_default,
         merch_config
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        data.store_key,
        data.key,
        data.label,
        data.image_url || null,
        data.text_color || null,
        data.sort_order ?? 0,
        data.status || 'active',
        !!data.is_default,
        JSON.stringify(data.merch_config),
      ]
    )
    return tab
  }

  async update(id, data) {
    const sets = []
    const params = []
    let idx = 1

    for (const col of [
      'store_key',
      'key',
      'label',
      'image_url',
      'text_color',
      'status',
    ]) {
      if (data[col] !== undefined) {
        sets.push(`${col} = $${idx++}`)
        params.push(data[col] || null)
      }
    }

    if (data.sort_order !== undefined) {
      sets.push(`sort_order = $${idx++}`)
      params.push(Number(data.sort_order) || 0)
    }

    if (data.is_default !== undefined) {
      sets.push(`is_default = $${idx++}`)
      params.push(!!data.is_default)
    }

    if (data.merch_config !== undefined) {
      sets.push(`merch_config = $${idx++}::jsonb`)
      params.push(JSON.stringify(data.merch_config))
    }

    if (data.status === 'archived') {
      sets.push(`archived_at = NOW()`)
    } else if (data.status === 'active') {
      sets.push(`archived_at = NULL`)
    }

    if (sets.length === 0) {
      return this.findById(id)
    }

    sets.push('updated_at = NOW()')
    params.push(id)

    const { rows: [tab] } = await query(
      `UPDATE theme_tabs
       SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      params
    )
    return tab || null
  }

  async clearDefaultsExcept(storeKey, exceptId) {
    await query(
      `UPDATE theme_tabs
       SET is_default = false, updated_at = NOW()
       WHERE store_key = $1
         AND is_default = true
         AND ($2::uuid IS NULL OR id != $2)`,
      [storeKey, exceptId]
    )
  }

  async archive(id) {
    return this.update(id, { status: 'archived' })
  }

  async restore(id) {
    return this.update(id, { status: 'active' })
  }
}
