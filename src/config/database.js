import pg from 'pg'
import { env } from './env.js'
import { logger } from './logger.js'
import { waitForDb } from '../database/waitForDb.js'

const { Pool } = pg

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT,
  ...(env.DB_SSL && { ssl: { rejectUnauthorized: false } }),
})

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error')
})

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected')
})

/**
 * Execute a parameterized SQL query
 * @param {string} text - SQL query with $1, $2, ... placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<pg.QueryResult>}
 */
export const query = (text, params) => pool.query(text, params)

/**
 * Get a client from the pool for transactions
 * @returns {Promise<pg.PoolClient>}
 */
export const getClient = () => pool.connect()

/**
 * Test the database connection
 */
export const testConnection = async () => {
  await waitForDb(pool, {
    retries: env.DB_CONNECT_RETRIES,
    delayMs: env.DB_CONNECT_RETRY_DELAY,
    logger,
  })

  const client = await pool.connect()
  try {
    await client.query('SELECT NOW()')
    logger.info('✅ PostgreSQL connected successfully')
  } finally {
    client.release()
  }
}

/**
 * Close the pool (for graceful shutdown)
 */
export const closePool = () => pool.end()
