import { createHash } from 'crypto'
import { query, getClient } from '../../../config/database.js'

function generateETag(themeData) {
  return createHash('md5').update(JSON.stringify(themeData)).digest('hex')
}

const THEME_SELECT = `
  SELECT
    theme.*,
    tab.store_key,
    tab.status AS tab_status,
    shop.name AS shop_name
  FROM app_themes theme
  LEFT JOIN theme_tabs tab ON tab.id = theme.tab_id
  LEFT JOIN shops shop ON shop.id = theme.shop_id
`

export class ThemesRepository {
  async findAll() {
    const { rows } = await query(
      `${THEME_SELECT}
       ORDER BY theme.created_at DESC`
    )
    return rows
  }

  async findById(id) {
    const { rows: [theme] } = await query(
      `${THEME_SELECT}
       WHERE theme.id = $1`,
      [id]
    )
    return theme || null
  }

  async findActive(shopId = null) {
    const { rows: [theme] } = await query(
      `${THEME_SELECT}
       WHERE theme.is_active = true
         AND (theme.shop_id = $1 OR theme.shop_id IS NULL)
       ORDER BY (theme.shop_id = $1) DESC NULLS LAST
       LIMIT 1`,
      [shopId]
    )
    return theme || null
  }

  async findAllTabThemes({ storeKey, status } = {}) {
    const conditions = ['theme.tab_id IS NOT NULL']
    const params = []
    let idx = 1

    if (status) {
      conditions.push(`theme.status = $${idx++}`)
      params.push(status)
    }

    if (storeKey) {
      conditions.push(`tab.store_key = $${idx++}`)
      params.push(storeKey)
    }

    const { rows } = await query(
      `${THEME_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY tab.store_key ASC, theme.tab_order ASC, theme.created_at DESC`,
      params
    )
    return rows
  }

  async findByTabKey(tabKey) {
    const { rows: [theme] } = await query(
      `${THEME_SELECT}
       WHERE theme.tab_key = $1
       LIMIT 1`,
      [tabKey]
    )
    return theme || null
  }

  async findTabMeta(tabId) {
    if (!tabId) return null

    const { rows: [tab] } = await query(
      `SELECT id, store_key, key, label, image_url, sort_order, status
       FROM theme_tabs
       WHERE id = $1`,
      [tabId]
    )
    return tab || null
  }

  async create(data) {
    const tabMeta = data.tab_id ? await this.findTabMeta(data.tab_id) : null
    const etag = generateETag(data.theme_data)

    const { rows: [theme] } = await query(
      `INSERT INTO app_themes (
         name,
         theme_data,
         shop_id,
         tab_id,
         tab_key,
         tab_label,
         tab_icon_url,
         tab_order,
         status,
         ab_variant,
         ab_split_percent,
         etag
       )
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        data.name,
        JSON.stringify(data.theme_data),
        data.shop_id || null,
        data.tab_id || null,
        tabMeta?.key ?? data.tab_key ?? null,
        tabMeta?.label ?? data.tab_label ?? null,
        tabMeta?.image_url ?? data.tab_icon_url ?? null,
        tabMeta?.sort_order ?? data.tab_order ?? 0,
        data.status || 'draft',
        data.ab_variant || 'A',
        data.ab_split_percent ?? 100,
        etag,
      ]
    )

    return this.findById(theme.id)
  }

  async createVersion(themeId, themeData, createdBy) {
    const { rows: [current] } = await query(
      'SELECT version FROM app_themes WHERE id = $1',
      [themeId]
    )
    const nextVersion = (current?.version || 0) + 1

    await query(
      `INSERT INTO app_theme_versions (theme_id, version, theme_data, created_by)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [themeId, nextVersion, JSON.stringify(themeData), createdBy]
    )

    return nextVersion
  }

  async getVersions(themeId) {
    const { rows } = await query(
      `SELECT id, version, created_by, created_at FROM app_theme_versions
       WHERE theme_id = $1 ORDER BY version DESC LIMIT 50`,
      [themeId]
    )
    return rows
  }

  async rollbackToVersion(themeId, versionId) {
    const { rows: [ver] } = await query(
      'SELECT theme_data FROM app_theme_versions WHERE id = $1 AND theme_id = $2',
      [versionId, themeId]
    )
    if (!ver) return null

    const { rows: [theme] } = await query(
      `UPDATE app_themes
       SET theme_data = $1::jsonb, etag = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id`,
      [JSON.stringify(ver.theme_data), generateETag(ver.theme_data), themeId]
    )

    return theme ? this.findById(theme.id) : null
  }

  async update(id, data) {
    const sets = []
    const params = []
    let idx = 1

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`)
      params.push(data.name)
    }

    if (data.theme_data !== undefined) {
      sets.push(`theme_data = $${idx++}::jsonb`)
      params.push(JSON.stringify(data.theme_data))
      sets.push(`etag = $${idx++}`)
      params.push(generateETag(data.theme_data))
    }

    if (data.tab_id !== undefined) {
      const tabMeta = data.tab_id ? await this.findTabMeta(data.tab_id) : null
      sets.push(`tab_id = $${idx++}`)
      params.push(data.tab_id || null)
      sets.push(`tab_key = $${idx++}`)
      params.push(tabMeta?.key ?? null)
      sets.push(`tab_label = $${idx++}`)
      params.push(tabMeta?.label ?? null)
      sets.push(`tab_icon_url = $${idx++}`)
      params.push(tabMeta?.image_url ?? null)
      sets.push(`tab_order = $${idx++}`)
      params.push(tabMeta?.sort_order ?? 0)
    }

    if (data.shop_id !== undefined) {
      sets.push(`shop_id = $${idx++}`)
      params.push(data.shop_id || null)
    }

    for (const col of ['tab_key', 'tab_label', 'tab_icon_url', 'status', 'ab_variant']) {
      if (data[col] !== undefined) {
        sets.push(`${col} = $${idx++}`)
        params.push(data[col])
      }
    }

    for (const col of ['tab_order', 'ab_split_percent', 'version']) {
      if (data[col] !== undefined) {
        sets.push(`${col} = $${idx++}`)
        params.push(Number(data[col]))
      }
    }

    for (const col of ['scheduled_at', 'expires_at']) {
      if (data[col] !== undefined) {
        sets.push(`${col} = $${idx++}`)
        params.push(data[col])
      }
    }

    if (sets.length === 0) return this.findById(id)

    sets.push('updated_at = NOW()')
    params.push(id)

    const { rows: [theme] } = await query(
      `UPDATE app_themes
       SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING id`,
      params
    )
    return theme ? this.findById(theme.id) : null
  }

  async activate(id) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [existing] } = await client.query(
        `SELECT theme.*, tab.store_key
         FROM app_themes theme
         LEFT JOIN theme_tabs tab ON tab.id = theme.tab_id
         WHERE theme.id = $1
         LIMIT 1`,
        [id]
      )

      if (!existing) {
        await client.query('ROLLBACK')
        return null
      }

      if (existing.tab_id) {
        await client.query(
          `UPDATE app_themes
           SET status = 'draft', updated_at = NOW()
           WHERE tab_id = $1
             AND ab_variant = $2
             AND id <> $3
             AND status = 'active'
             AND shop_id IS NOT DISTINCT FROM $4`,
          [existing.tab_id, existing.ab_variant, id, existing.shop_id ?? null]
        )
      }

      const shouldUpdateActiveFlag =
        existing.tab_key === 'all' &&
        existing.ab_variant === 'A' &&
        existing.store_key === 'marketplace'

      if (shouldUpdateActiveFlag) {
        // Scoped to the same shop bucket (NULL-safe) so activating one
        // shop's theme never deactivates another shop's — or the platform
        // default's — active theme.
        await client.query(
          `UPDATE app_themes
              SET is_active = false, updated_at = NOW()
            WHERE is_active = true
              AND shop_id IS NOT DISTINCT FROM $1`,
          [existing.shop_id ?? null]
        )
      }

      await client.query(
        `UPDATE app_themes
         SET status = 'active',
             is_active = CASE WHEN $2 THEN true ELSE is_active END,
             updated_at = NOW()
         WHERE id = $1`,
        [id, shouldUpdateActiveFlag]
      )

      await client.query('COMMIT')
      return this.findById(id)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async remove(id) {
    const { rowCount } = await query(
      'DELETE FROM app_themes WHERE id = $1 AND is_active = false',
      [id]
    )
    return rowCount > 0
  }
}
