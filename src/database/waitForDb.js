const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const formatError = (err) => {
  if (!err) return 'Unknown database error'
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors
      .map((item) => item.message || item.code || String(item))
      .join(' | ')
  }
  if (Array.isArray(err.aggregateErrors) && err.aggregateErrors.length > 0) {
    return err.aggregateErrors
      .map((item) => item.message || item.code || String(item))
      .join(' | ')
  }
  if (err.code && err.message) return `${err.code}: ${err.message}`
  return err.message || String(err)
}

/**
 * Wait until PostgreSQL accepts connections.
 * Useful when DB container starts slower than app/migration scripts.
 */
export const waitForDb = async (pool, options = {}) => {
  const retries =
    Number(options.retries ?? process.env.DB_CONNECT_RETRIES) || 20
  const delayMs =
    Number(options.delayMs ?? process.env.DB_CONNECT_RETRY_DELAY) || 1000
  const logger = options.logger || console

  let lastError

  for (let attempt = 1; attempt <= retries; attempt++) {
    let client

    try {
      client = await pool.connect()
      await client.query('SELECT 1')

      if (attempt > 1 && logger.info) {
        logger.info(`PostgreSQL is ready (attempt ${attempt}/${retries})`)
      }
      return
    } catch (err) {
      lastError = err

      if (attempt < retries && logger.warn) {
        logger.warn(
          `PostgreSQL not ready (${attempt}/${retries}): ${formatError(err)}. Retrying in ${delayMs}ms`
        )
      }

      if (attempt < retries) {
        await sleep(delayMs)
      }
    } finally {
      if (client) client.release()
    }
  }

  throw lastError
}
