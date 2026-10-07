import { query } from '../../config/database.js'

const COLUMNS = `
  id, pincode, city, area, state, is_active,
  created_by, updated_by, created_at, updated_at
`

/**
 * Pincode Mappings repository — admin-curated pincode -> city/area/state
 * overrides (migration 089). See that migration's header for why this
 * table exists.
 */
export class PincodeMappingsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM pincode_mappings ORDER BY pincode ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM pincode_mappings WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async findByPincode(pincode) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM pincode_mappings WHERE pincode = $1`,
      [String(pincode)]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Used by addresses.service.js#validatePincode — only an ACTIVE match counts. */
  async findActiveByPincode(pincode) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM pincode_mappings WHERE pincode = $1 AND is_active = true`,
      [String(pincode)]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(data, actorId) {
    const { rows } = await query(
      `INSERT INTO pincode_mappings (
         pincode, city, area, state, is_active, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$6)
       RETURNING ${COLUMNS}`,
      [
        data.pincode,
        data.city,
        data.area ?? null,
        data.state,
        data.isActive ?? true,
        actorId ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async update(id, data, actorId) {
    const fields = []
    const params = []
    let idx = 1

    const set = (column, value) => {
      fields.push(`${column} = $${idx++}`)
      params.push(value)
    }

    if (data.pincode !== undefined) set('pincode', data.pincode)
    if (data.city !== undefined) set('city', data.city)
    if (data.area !== undefined) set('area', data.area)
    if (data.state !== undefined) set('state', data.state)
    if (data.isActive !== undefined) set('is_active', data.isActive)

    if (fields.length === 0) return this.findById(id)

    fields.push('updated_at = NOW()')
    set('updated_by', actorId ?? null)
    params.push(id)

    const { rows } = await query(
      `UPDATE pincode_mappings SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async remove(id) {
    const result = await query(`DELETE FROM pincode_mappings WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      pincode: row.pincode,
      city: row.city,
      area: row.area,
      state: row.state,
      isActive: row.is_active,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
