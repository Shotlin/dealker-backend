// Feature: multi-vendor-system, task 13.4
// Report pre-compute worker — runs slow report queries (>100ms median)
// and caches results to Redis under deterministic keys.
//
// Job types:
//   - `precompute` — Runs a named report query and stores the JSON result
//     in Redis with a TTL. The cache key is deterministic based on the
//     report type and parameters so HTTP handlers can serve from cache.
//
// Supported reports:
//   - financial-summary  — Admin financial report (aggregates across shops)
//   - payout-report      — Payout CSV data (joins shop_financials + shops)
//   - sales-analytics    — Sales analytics with date range
//   - customer-cohorts   — Customer cohort analysis
//
// Retry / concurrency:
//   - Concurrency 2 (read-only queries, safe to overlap)
//   - 3 attempts with exponential backoff (queue defaults)
//   - Per-job target: complete within 30s
//
// Cache key format: `bakaloo:reports:{reportType}:v1:{paramHash}`
// TTL: 5 minutes (300s) — reports are pre-computed frequently enough
// that stale data is acceptable for dashboard views.

import { createHash } from 'node:crypto'
import { logger } from '../config/logger.js'
import { redis } from '../config/redis.js'
import { query } from '../config/database.js'

const REPORT_CACHE_TTL = 300 // 5 minutes
const REPORT_CACHE_PREFIX = 'bakaloo:reports'

/**
 * Compute a deterministic cache key for a report.
 * @param {string} reportType
 * @param {object} params
 * @returns {string}
 */
function buildCacheKey(reportType, params) {
  const paramStr = JSON.stringify(params || {})
  const hash = createHash('sha256').update(paramStr).digest('hex').slice(0, 16)
  return `${REPORT_CACHE_PREFIX}:${reportType}:v1:${hash}`
}

/**
 * Build a report-precompute job processor.
 *
 * @param {object} [deps]
 * @param {typeof query} [deps.dbQuery] - Database query function (for testing)
 * @param {typeof redis} [deps.redisClient] - Redis client (for testing)
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createReportPrecomputeProcessor(deps = {}) {
  const dbQuery = deps.dbQuery || query
  const redisClient = deps.redisClient || redis

  return async function processReportPrecomputeJob(job) {
    const reportType = job?.data?.reportType
    const params = job?.data?.params || {}

    if (!reportType) {
      logger.warn(
        { jobId: job?.id, action: 'report_precompute_missing_type' },
        'report-precompute job missing reportType'
      )
      return { cached: false, reason: 'MISSING_REPORT_TYPE' }
    }

    const handler = REPORT_HANDLERS[reportType]
    if (!handler) {
      logger.warn(
        { jobId: job?.id, reportType, action: 'report_precompute_unknown_type' },
        'Unknown report type for pre-compute'
      )
      return { cached: false, reason: 'UNKNOWN_REPORT_TYPE' }
    }

    const cacheKey = buildCacheKey(reportType, params)
    const startMs = Date.now()

    try {
      const result = await handler(params, { dbQuery })
      const durationMs = Date.now() - startMs

      await redisClient.set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        REPORT_CACHE_TTL
      )

      logger.info(
        {
          reportType,
          cacheKey,
          durationMs,
          rowCount: Array.isArray(result) ? result.length : null,
          action: 'report_precompute_cached',
        },
        'Report pre-computed and cached'
      )

      return { cached: true, reportType, cacheKey, durationMs }
    } catch (err) {
      const durationMs = Date.now() - startMs
      logger.error(
        {
          reportType,
          cacheKey,
          durationMs,
          err: err.message,
          action: 'report_precompute_failed',
        },
        'Report pre-compute failed'
      )
      throw err // Let BullMQ retry
    }
  }
}

// ─── REPORT HANDLERS ─────────────────────────────────────

const REPORT_HANDLERS = {
  'financial-summary': handleFinancialSummary,
  'payout-report': handlePayoutReport,
  'sales-analytics': handleSalesAnalytics,
  'customer-cohorts': handleCustomerCohorts,
}

async function handleFinancialSummary(params, { dbQuery }) {
  const conditions = ["o.status = 'DELIVERED'"]
  const values = []

  if (params.startDate) {
    values.push(params.startDate)
    conditions.push(`o.created_at >= $${values.length}::timestamptz`)
  }
  if (params.endDate) {
    values.push(params.endDate)
    conditions.push(`o.created_at <= $${values.length}::timestamptz`)
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : ''

  const { rows } = await dbQuery(
    `SELECT
       COUNT(o.id) AS total_orders,
       COALESCE(SUM(o.total_amount), 0) AS total_revenue,
       COALESCE(SUM(o.delivery_fee), 0) AS total_delivery_fees,
       COALESCE(AVG(o.total_amount), 0) AS avg_order_value
     FROM orders o
     ${whereClause}`,
    values
  )

  return rows[0] || {}
}

async function handlePayoutReport(params, { dbQuery }) {
  const conditions = []
  const values = []

  if (params.from) {
    values.push(params.from)
    conditions.push(`sf.period_start >= $${values.length}::date`)
  }
  if (params.to) {
    values.push(params.to)
    conditions.push(`sf.period_end <= $${values.length}::date`)
  }
  if (params.payout_status) {
    values.push(params.payout_status)
    conditions.push(`sf.payout_status = $${values.length}`)
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : ''

  const { rows } = await dbQuery(
    `SELECT
       sf.id, sf.shop_id, s.name AS shop_name,
       sf.period_type, sf.period_start, sf.period_end,
       sf.gross_revenue, sf.net_revenue, sf.payout_amount,
       sf.payout_status, sf.payout_ref, sf.paid_at
     FROM shop_financials sf
     LEFT JOIN shops s ON s.id = sf.shop_id
     ${whereClause}
     ORDER BY sf.period_start DESC
     LIMIT 5000`,
    values
  )

  return rows
}

async function handleSalesAnalytics(params, { dbQuery }) {
  const conditions = ["o.status = 'DELIVERED'"]
  const values = []

  if (params.startDate) {
    values.push(params.startDate)
    conditions.push(`o.created_at >= $${values.length}::timestamptz`)
  }
  if (params.endDate) {
    values.push(params.endDate)
    conditions.push(`o.created_at <= $${values.length}::timestamptz`)
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`

  const { rows } = await dbQuery(
    `SELECT
       DATE(o.created_at) AS date,
       COUNT(o.id) AS order_count,
       COALESCE(SUM(o.total_amount), 0) AS revenue
     FROM orders o
     ${whereClause}
     GROUP BY DATE(o.created_at)
     ORDER BY date DESC
     LIMIT 365`,
    values
  )

  return rows
}

async function handleCustomerCohorts(params, { dbQuery }) {
  const { rows } = await dbQuery(
    `SELECT
       DATE_TRUNC('month', u.created_at) AS cohort_month,
       COUNT(DISTINCT u.id) AS new_customers,
       COUNT(DISTINCT o.user_id) AS ordered_customers
     FROM users u
     LEFT JOIN orders o ON o.user_id = u.id
       AND o.status = 'DELIVERED'
     WHERE u.role = 'customer'
     GROUP BY DATE_TRUNC('month', u.created_at)
     ORDER BY cohort_month DESC
     LIMIT 24`,
    []
  )

  return rows
}

/**
 * Get a pre-computed report from cache.
 * Returns null if not cached (caller should fall back to live query).
 *
 * @param {string} reportType
 * @param {object} params
 * @returns {Promise<*|null>}
 */
export async function getCachedReport(reportType, params) {
  const cacheKey = buildCacheKey(reportType, params)
  const cached = await redis.get(cacheKey)
  if (!cached) return null
  try {
    return JSON.parse(cached)
  } catch {
    return null
  }
}

export { buildCacheKey, REPORT_CACHE_PREFIX, REPORT_CACHE_TTL }
