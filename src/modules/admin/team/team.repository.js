import { query, getClient } from '../../../config/database.js'
import bcrypt from 'bcrypt'

export class TeamRepository {
    /* ── Roles ── */

    async findAllRoles() {
        const { rows } = await query(`
      SELECT r.*,
             (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id AND u.role = 'ADMIN') AS admin_count
      FROM roles r
      ORDER BY r.is_system DESC, r.name ASC
    `)
        return rows
    }

    async findRoleById(id) {
        const { rows: [role] } = await query('SELECT * FROM roles WHERE id = $1', [id])
        return role || null
    }

    async createRole({ name, description, permissions }) {
        const { rows: [role] } = await query(
            `INSERT INTO roles (name, description, permissions)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
            [name, description || '', JSON.stringify(permissions || [])]
        )
        return { ...role, admin_count: 0 }
    }

    async updateRole(id, { name, description, permissions }) {
        const sets = []
        const params = []
        let idx = 1

        if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name) }
        if (description !== undefined) { sets.push(`description = $${idx++}`); params.push(description) }
        if (permissions !== undefined) { sets.push(`permissions = $${idx++}::jsonb`); params.push(JSON.stringify(permissions)) }

        if (sets.length === 0) return this.findRoleById(id)

        sets.push(`updated_at = NOW()`)
        params.push(id)

        const { rows: [role] } = await query(
            `UPDATE roles SET ${sets.join(', ')} WHERE id = $${idx} AND is_system = false RETURNING *`,
            params
        )
        return role || null
    }

    async deleteRole(id) {
        // Don't delete system roles; reassign members to null
        const client = await getClient()
        try {
            await client.query('BEGIN')
            await client.query('UPDATE users SET role_id = NULL WHERE role_id = $1', [id])
            const { rowCount } = await client.query('DELETE FROM roles WHERE id = $1 AND is_system = false', [id])
            await client.query('COMMIT')
            return rowCount > 0
        } catch (err) {
            await client.query('ROLLBACK')
            throw err
        } finally {
            client.release()
        }
    }

    /* ── Team Members ── */

    async findAllMembers() {
        const { rows } = await query(`
      SELECT u.id, u.name, u.email, u.phone, u.role_id, u.is_active, u.created_at,
             COALESCE(r.name, 'No Role') AS role_name,
             COALESCE(r.permissions, '[]'::jsonb) AS permissions
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.role = 'ADMIN'
      ORDER BY u.created_at ASC
    `)
        return rows
    }

    async findMemberById(id) {
        const { rows: [member] } = await query(`
      SELECT u.id, u.name, u.email, u.phone, u.role_id, u.is_active, u.created_at,
             COALESCE(r.name, 'No Role') AS role_name,
             COALESCE(r.permissions, '[]'::jsonb) AS permissions
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.role = 'ADMIN'
    `, [id])
        return member || null
    }

    async inviteMember({ name, email, phone, roleId, passwordHash }) {
        const { rows: [user] } = await query(
            `INSERT INTO users (name, email, phone, role, role_id, password_hash, is_active)
       VALUES ($1, $2, $3, 'ADMIN', $4, $5, true)
       RETURNING id, name, email, phone, role_id, is_active, created_at`,
            [name, email, phone || null, roleId, passwordHash]
        )
        return user
    }

    async updateMember(id, { roleId, isActive }) {
        const sets = []
        const params = []
        let idx = 1

        if (roleId !== undefined) { sets.push(`role_id = $${idx++}`); params.push(roleId) }
        if (isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(isActive) }

        if (sets.length === 0) return this.findMemberById(id)

        sets.push(`updated_at = NOW()`)
        params.push(id)

        await query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} AND role = 'ADMIN'`,
            params
        )
        return this.findMemberById(id)
    }

    async removeMember(id) {
        // Instead of deleting, deactivate the user
        const { rowCount } = await query(
            `UPDATE users SET is_active = false, role_id = NULL, updated_at = NOW() WHERE id = $1 AND role = 'ADMIN'`,
            [id]
        )
        return rowCount > 0
    }

    async findByEmail(email) {
        const { rows: [user] } = await query('SELECT id FROM users WHERE email = $1', [email])
        return user || null
    }

    /**
     * Set a new password hash for a team member, force a password change on
     * their next login, and bump session_version so every previously issued
     * JWT for this user is invalidated immediately (mirrors shop-staff's
     * `resetPasswordTx` — same `users` table, same three-column contract).
     */
    async resetPassword(id, passwordHash) {
        const { rowCount } = await query(
            `UPDATE users
                SET password_hash = $1,
                    force_password_change = true,
                    session_version = session_version + 1,
                    updated_at = NOW()
              WHERE id = $2 AND role = 'ADMIN'`,
            [passwordHash, id]
        )
        return rowCount > 0
    }
}
