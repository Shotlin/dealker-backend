/**
 * Seed runner — executes all seed files in order
 */
import pg from 'pg'
import dotenv from 'dotenv'
import { seedCategories } from './categories.seed.js'
import { seedProducts } from './products.seed.js'
import { waitForDb } from '../waitForDb.js'

dotenv.config()

async function run() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })

  try {
    await waitForDb(pool, {
      logger: {
        info: (msg) => console.log(msg),
        warn: (msg) => console.log(msg),
      },
    })

    console.log('🌱 Starting seed...\n')

    const categories = await seedCategories(pool)
    await seedProducts(pool, categories)

    console.log('\n🎉 All seeds completed!')
  } catch (err) {
    console.error('Seed failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

run()
