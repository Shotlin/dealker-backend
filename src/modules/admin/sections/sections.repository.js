import { getClient, query } from '../../../config/database.js'

const SECTION_SELECT = `
  SELECT
    sm.*,
    tt.key AS tab_key,
    tt.store_key
  FROM section_manifests sm
  JOIN theme_tabs tt ON tt.id = sm.tab_id
`

export class SectionsRepository {
  async findTabById(tabId) {
    const { rows: [tab] } = await query(
      `SELECT id, key, store_key
       FROM theme_tabs
       WHERE id = $1`,
      [tabId]
    )
    return tab || null
  }

  async ensureShopLayout(tabId, shopId) {
    if (!shopId) return

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO section_layout_scopes (tab_id, shop_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING tab_id`,
        [tabId, shopId]
      )
      // Copy the global layout once, preserving its order. The marker means
      // an intentionally empty shop layout stays empty after a reload.
      if (rows.length > 0) {
        await client.query(
          `INSERT INTO section_manifests (
             tab_id, shop_id, section_type, sort_order, visible, config, merch_binding
           )
           SELECT tab_id, $2, section_type, sort_order, visible, config, merch_binding
           FROM section_manifests
           WHERE tab_id = $1 AND shop_id IS NULL
           ORDER BY sort_order ASC`,
          [tabId, shopId]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async findByTabId(tabId, shopId = null, { ensureShopScope = false } = {}) {
    if (ensureShopScope && shopId) {
      await this.ensureShopLayout(tabId, shopId)
    }
    const { rows } = await query(
      `SELECT * FROM section_manifests
       WHERE tab_id = $1
         AND shop_id IS NOT DISTINCT FROM $2
       ORDER BY sort_order ASC`,
      [tabId, shopId]
    )
    return rows
  }

  async findById(id) {
    const { rows: [section] } = await query(
      `${SECTION_SELECT}
       WHERE sm.id = $1`,
      [id]
    )
    return section || null
  }

  async create(tabId, data, shopId = null) {
    if (shopId) await this.ensureShopLayout(tabId, shopId)
    const { rows: [{ max_order }] } = await query(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order
       FROM section_manifests
       WHERE tab_id = $1 AND shop_id IS NOT DISTINCT FROM $2`,
      [tabId, shopId]
    )

    const { rows: [section] } = await query(
      `INSERT INTO section_manifests (
         tab_id,
         shop_id,
         section_type,
         sort_order,
         visible,
         config,
         merch_binding
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING *`,
      [
        tabId,
        shopId,
        data.section_type,
        max_order + 1,
        data.visible ?? true,
        JSON.stringify(data.config || {}),
        data.merch_binding ? JSON.stringify(data.merch_binding) : null,
      ]
    )

    return section
  }

  async update(id, data) {
    const sets = []
    const params = []
    let idx = 1

    if (data.config !== undefined) {
      sets.push(`config = $${idx++}::jsonb`)
      params.push(JSON.stringify(data.config))
    }

    if (data.visible !== undefined) {
      sets.push(`visible = $${idx++}`)
      params.push(data.visible)
    }

    if (data.section_type !== undefined) {
      sets.push(`section_type = $${idx++}`)
      params.push(data.section_type)
    }

    if (sets.length === 0) {
      return this.findById(id)
    }

    params.push(id)

    const { rows: [section] } = await query(
      `UPDATE section_manifests
       SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      params
    )

    return section || null
  }

  async updateMerchBinding(id, merchBinding) {
    const { rows: [section] } = await query(
      `UPDATE section_manifests
       SET merch_binding = $1::jsonb
       WHERE id = $2
       RETURNING *`,
      [merchBinding ? JSON.stringify(merchBinding) : null, id]
    )

    return section || null
  }

  async delete(id) {
    const section = await this.findById(id)
    if (!section) return null

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM section_manifests WHERE id = $1', [id])
    await client.query(
        `WITH numbered AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order ASC, created_at ASC) - 1 AS new_order
           FROM section_manifests
           WHERE tab_id = $1 AND shop_id IS NOT DISTINCT FROM $2
         )
         UPDATE section_manifests sm
         SET sort_order = numbered.new_order
         FROM numbered
         WHERE sm.id = numbered.id`,
        [section.tab_id, section.shop_id]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return section
  }

  async reorder(tabId, orderedIds, shopId = null) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          `UPDATE section_manifests
           SET sort_order = $1
           WHERE id = $2 AND tab_id = $3 AND shop_id IS NOT DISTINCT FROM $4`,
          [i, orderedIds[i], tabId, shopId]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return this.findByTabId(tabId, shopId)
  }

  async duplicate(id) {
    const original = await this.findById(id)
    if (!original) return null

    const { rows: [{ max_order }] } = await query(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order
       FROM section_manifests
       WHERE tab_id = $1 AND shop_id IS NOT DISTINCT FROM $2`,
      [original.tab_id, original.shop_id]
    )

    const { rows: [section] } = await query(
      `INSERT INTO section_manifests (
         tab_id,
         shop_id,
         section_type,
         sort_order,
         visible,
         config,
         merch_binding
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING *`,
      [
        original.tab_id,
        original.shop_id,
        original.section_type,
        max_order + 1,
        original.visible,
        JSON.stringify(original.config || {}),
        original.merch_binding ? JSON.stringify(original.merch_binding) : null,
      ]
    )

    return section || null
  }

  async createVersion(tabId, snapshot, createdBy, options = {}) {
    const {
      scheduledAt = null,
      status = 'applied',
      abVariant = 'A',
      abSplitPercent = 0,
    } = options

    const { rows: [version] } = await query(
      `INSERT INTO section_manifest_versions (
         tab_id,
         version,
         snapshot,
         created_by,
         scheduled_at,
         status,
         ab_variant,
         ab_split_percent
       )
       VALUES (
         $1,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM section_manifest_versions WHERE tab_id = $1),
         $2::jsonb,
         $3,
         $4,
         $5,
         $6,
         $7
       )
       RETURNING *`,
      [
        tabId,
        JSON.stringify(snapshot || []),
        createdBy,
        scheduledAt,
        status,
        abVariant,
        abSplitPercent,
      ]
    )

    return version || null
  }

  async getVersions(tabId) {
    const { rows } = await query(
      `SELECT
         id,
         version,
         created_by,
         scheduled_at,
         status,
         ab_variant,
         ab_split_percent,
         created_at
       FROM section_manifest_versions
       WHERE tab_id = $1
       ORDER BY version DESC
       LIMIT 50`,
      [tabId]
    )
    return rows
  }

  async findVersionById(tabId, versionId) {
    const { rows: [version] } = await query(
      `SELECT *
       FROM section_manifest_versions
       WHERE id = $1 AND tab_id = $2`,
      [versionId, tabId]
    )
    return version || null
  }

  async expireScheduledVersions(tabId) {
    const { rows } = await query(
      `UPDATE section_manifest_versions
       SET status = 'expired'
       WHERE tab_id = $1
         AND status = 'scheduled'
       RETURNING *`,
      [tabId]
    )
    return rows
  }

  async restoreSnapshot(tabId, snapshot) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM section_manifests WHERE tab_id = $1', [tabId])

      const orderedSnapshot = [...(snapshot || [])].sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      )

      for (const section of orderedSnapshot) {
        await client.query(
          `INSERT INTO section_manifests (
             tab_id,
             section_type,
             sort_order,
             visible,
             config,
             merch_binding
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [
            tabId,
            section.section_type,
            section.sort_order ?? 0,
            section.visible ?? true,
            JSON.stringify(section.config || {}),
            section.merch_binding ? JSON.stringify(section.merch_binding) : null,
          ]
        )
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return this.findByTabId(tabId)
  }
}
