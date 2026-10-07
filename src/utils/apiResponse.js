/**
 * Consistent API response helpers
 * Every API response follows the same shape
 */

/**
 * Success response
 * @param {*} data
 * @param {string} message
 * @param {object} meta - Additional metadata (pagination, etc.)
 * @returns {object}
 */
export function success(data, message = 'Success', meta = {}) {
  return {
    success: true,
    message,
    data,
    ...meta,
  }
}

/**
 * Error response (use reply.code(xxx).send(error(...)))
 * @param {string} message
 * @param {string} code - Machine-readable error code
 * @returns {object}
 */
export function error(message, code = 'ERROR') {
  return {
    success: false,
    message,
    code,
  }
}
