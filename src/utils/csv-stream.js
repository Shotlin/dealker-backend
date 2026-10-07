/**
 * CSV streaming utility for report exports.
 *
 * Streams rows as CSV with a max of 10,000 rows.
 * Uses Node.js streams for memory efficiency.
 *
 * @module utils/csv-stream
 */

const MAX_EXPORT_ROWS = 10000

/**
 * Escape a CSV field value.
 * Wraps in quotes if it contains commas, quotes, or newlines.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Convert an array of objects to a CSV string with headers.
 *
 * @param {object[]} rows - Array of row objects
 * @param {string[]} [columns] - Column names (defaults to keys of first row)
 * @returns {string} CSV content
 */
export function rowsToCsv(rows, columns) {
  if (!rows || rows.length === 0) return ''

  const limitedRows = rows.slice(0, MAX_EXPORT_ROWS)
  const cols = columns || Object.keys(limitedRows[0])

  const header = cols.map(escapeCsvField).join(',')
  const lines = limitedRows.map((row) =>
    cols.map((col) => escapeCsvField(row[col])).join(',')
  )

  return [header, ...lines].join('\n')
}

/**
 * Stream CSV response for a Fastify reply.
 *
 * @param {import('fastify').FastifyReply} reply - Fastify reply object
 * @param {object[]} rows - Data rows
 * @param {string} filename - Download filename
 * @param {string[]} [columns] - Column names
 */
export function streamCsvResponse(reply, rows, filename, columns) {
  const csv = rowsToCsv(rows, columns)

  reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(csv)
}

export { MAX_EXPORT_ROWS }
