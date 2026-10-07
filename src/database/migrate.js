/**
 * Database migration runner
 * Reads .sql files from migrations/ in order and executes them
 * Tracks applied migrations in a _migrations table
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import dotenv from 'dotenv'
import { waitForDb } from './waitForDb.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

async function migrate() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })

  await waitForDb(pool, {
    logger: {
      info: (msg) => console.log(msg),
      warn: (msg) => console.log(msg),
    },
  })

  const client = await pool.connect()

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id          SERIAL PRIMARY KEY,
        filename    VARCHAR(255) UNIQUE NOT NULL,
        applied_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    // Get already applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM _migrations ORDER BY filename'
    )
    const appliedSet = new Set(applied.map((r) => r.filename))

    // Read migration files sorted by name
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    let count = 0
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  ✓ ${file} (already applied)`)
        continue
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file]
        )
        await client.query('COMMIT')
        console.log(`  ✅ ${file} applied`)
        count++
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`  ❌ ${file} FAILED:`, err.message)
        throw err
      }
    }

    console.log(`\n🎉 Migration complete — ${count} new migration(s) applied`)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
