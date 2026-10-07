import slugifyLib from 'slugify'
import crypto from 'node:crypto'

/**
 * Generate a URL-safe slug from text
 * Appends a short random suffix for uniqueness
 * @param {string} text
 * @returns {string}
 */
export function generateSlug(text) {
  const base = slugifyLib(text, {
    lower: true,
    strict: true,
    trim: true,
  })
  const suffix = crypto.randomBytes(3).toString('hex')  // 6 chars
  return `${base}-${suffix}`
}

/**
 * Generate a slug without random suffix (for categories etc.)
 * @param {string} text
 * @returns {string}
 */
export function simpleSlug(text) {
  return slugifyLib(text, {
    lower: true,
    strict: true,
    trim: true,
  })
}
