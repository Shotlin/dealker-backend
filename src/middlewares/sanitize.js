/**
 * Input sanitization onRequest hook
 * Recursively trims strings and strips potential XSS from request body
 */
export async function sanitize(request) {
  if (request.body && typeof request.body === 'object') {
    request.body = sanitizeObject(request.body)
  }
}

/**
 * Recursively sanitize an object's string values
 */
function sanitizeObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeValue)
  }

  if (obj !== null && typeof obj === 'object') {
    const cleaned = {}
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = sanitizeValue(value)
    }
    return cleaned
  }

  return sanitizeValue(obj)
}

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return value
      .trim()
      // Strip HTML tags
      .replace(/<[^>]*>/g, '')
      // Strip script-related patterns
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }

  if (value !== null && typeof value === 'object') {
    return sanitizeObject(value)
  }

  return value
}
