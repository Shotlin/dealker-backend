import { query } from '../../config/database.js'

/**
 * Fee config repository — CRUD for fee_config table
 */
export class FeeConfigRepository {
  async getAll() {
    const { rows } = await query(
      `SELECT * FROM fee_config
       ORDER BY fee_type`
    )
    return rows.map((row) => this._format(row))
  }

  async getByType(feeType) {
    const { rows } = await query(
      `SELECT * FROM fee_config WHERE fee_type = $1`,
      [feeType]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async update(feeType, data) {
    const { rows } = await query(
      `UPDATE fee_config
       SET amount = $1,
           free_threshold = $2,
           is_active = $3,
           description = $4,
           start_hour = $5,
           end_hour = $6,
           updated_at = NOW()
       WHERE fee_type = $7
       RETURNING *`,
      [
        data.amount,
        data.free_threshold,
        data.is_active,
        data.description,
        data.start_hour,
        data.end_hour,
        feeType,
      ]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      ...row,
      amount: this._toNumber(row.amount),
      free_threshold: row.free_threshold === null ? null : this._toNumber(row.free_threshold),
    }
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
}
