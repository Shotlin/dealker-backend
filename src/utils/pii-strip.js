/**
 * PII stripping utility for report responses.
 *
 * Removes personally identifiable information (full_name, phone, email)
 * from report data rows. Used by HQ reports to comply with data
 * minimization — PII is only exposed on specific endpoints
 * (e.g., /customer-acquisition) for users with appropriate permissions.
 *
 * @module utils/pii-strip
 */

const PII_FIELDS = ['full_name', 'phone', 'email']

/**
 * Strip PII fields from a single row object.
 * Returns a shallow copy without PII keys.
 *
 * @param {object} row
 * @returns {object}
 */
export function stripPiiFromRow(row) {
  if (!row || typeof row !== 'object') return row
  const cleaned = { ...row }
  for (const field of PII_FIELDS) {
    delete cleaned[field]
  }
  return cleaned
}

/**
 * Strip PII fields from an array of row objects.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function stripPiiFromRows(rows) {
  if (!Array.isArray(rows)) return rows
  return rows.map(stripPiiFromRow)
}

/**
 * Strip PII from a paginated response object.
 * Expects `{ data: [...], ...meta }` shape.
 *
 * @param {object} response - Response with `data` array
 * @returns {object}
 */
export function stripPiiFromResponse(response) {
  if (!response || typeof response !== 'object') return response
  if (Array.isArray(response.data)) {
    return { ...response, data: stripPiiFromRows(response.data) }
  }
  return response
}
