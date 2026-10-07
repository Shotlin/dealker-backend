/**
 * Idempotent local-dev super-admin bootstrap.
 *
 * Creates (or updates) a single super-admin user so the dashboard can be
 * logged into via /api/v1/admin/auth/login. Local-only — production
 * uses team invites + the full RBAC flow.
 *
 * Follows the same pattern as src/database/seeds/run.js:
 *   - parameterized SQL ($1..$N), no string concatenation
 *   - bcrypt cost factor 12 (matches src/modules/admin/team/team.service.js)
 *   - secrets sourced from env vars (LOCAL_ADMIN_EMAIL / LOCAL_ADMIN_PASSWORD)
 *   - single transaction, client released and pool closed in finally
 *   - WHERE clauses hit indexed columns (roles.name UNIQUE, users.email UNIQUE)
 */
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcrypt'

const EMAIL = process.env.LOCAL_ADMIN_EMAIL || 'admin@bakaloo.com'
const PASSWORD = process.env.LOCAL_ADMIN_PASSWORD || 'Admin@123'
const NAME = 'Super Admin'
const PHONE = '9000000000'

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: roleRows } = await client.query(
      `SELECT id FROM roles WHERE name = $1 AND is_system = true LIMIT 1`,
      ['Super Admin']
    )
    if (!roleRows[0]) {
      throw new Error(
        'Super Admin role not found — run db:migrate first (028_roles_table.sql)'
      )
    }
    const superAdminRoleId = roleRows[0].id

    const passwordHash = await bcrypt.hash(PASSWORD, 12)

    const { rows } = await client.query(
      `INSERT INTO users (phone, email, name, role, role_id, platform_role, password_hash, is_active, is_blocked)
       VALUES ($1, $2, $3, 'ADMIN', $4, 'SUPER_ADMIN', $5, true, false)
       ON CONFLICT (email) DO UPDATE SET
         role = 'ADMIN',
         role_id = EXCLUDED.role_id,
         platform_role = EXCLUDED.platform_role,
         password_hash = EXCLUDED.password_hash,
         is_active = true,
         is_blocked = false,
         name = EXCLUDED.name,
         updated_at = NOW()
       RETURNING id, email, role`,
      [PHONE, EMAIL, NAME, superAdminRoleId, passwordHash]
    )

    await client.query('COMMIT')

    console.log('✅ Super-admin ready')
    console.log('   id:       ', rows[0].id)
    console.log('   email:    ', rows[0].email)
    console.log('   role:     ', rows[0].role)
    console.log('   password: ', PASSWORD, '  (local dev only)')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ seed-super-admin failed:', err.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
