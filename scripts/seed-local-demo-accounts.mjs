/**
 * Idempotent local-dev demo account bootstrap.
 *
 * The super-admin account is maintained by seed-super-admin.mjs. This script
 * adds a separate HQ admin account so local dashboard permissions can be
 * compared without using a production identity.
 */
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcrypt'

const EMAIL = process.env.LOCAL_HQ_ADMIN_EMAIL || 'manager@bakaloo.com'
const PASSWORD = process.env.LOCAL_HQ_ADMIN_PASSWORD || 'Manager@123'
const PHONE = '9000000002'
const NAME = 'Demo Admin'

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
      ['Admin'],
    )
    if (!roleRows[0]) throw new Error('Admin role not found — run db:migrate first')

    const passwordHash = await bcrypt.hash(PASSWORD, 12)
    const { rows } = await client.query(
      `INSERT INTO users
         (phone, email, name, role, role_id, platform_role, password_hash, is_active, is_blocked)
       VALUES ($1, $2, $3, 'ADMIN', $4, 'ADMIN', $5, true, false)
       ON CONFLICT (email) DO UPDATE SET
         role = 'ADMIN',
         role_id = EXCLUDED.role_id,
         platform_role = EXCLUDED.platform_role,
         password_hash = EXCLUDED.password_hash,
         is_active = true,
         is_blocked = false,
         name = EXCLUDED.name,
         updated_at = NOW()
       RETURNING id, email, role, platform_role`,
      [PHONE, EMAIL, NAME, roleRows[0].id, passwordHash],
    )

    await client.query('COMMIT')
    console.log('✅ Local HQ admin ready')
    console.log(`   id:       ${rows[0].id}`)
    console.log(`   email:    ${rows[0].email}`)
    console.log(`   role:     ${rows[0].role}`)
    console.log(`   platform: ${rows[0].platform_role}`)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ seed-local-demo-accounts failed:', error.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
