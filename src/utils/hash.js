import bcrypt from 'bcrypt'

const SALT_ROUNDS = 12

/**
 * Hash a password using bcrypt (async — never use hashSync)
 * @param {string} plaintext
 * @returns {Promise<string>} Hashed password
 */
export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, SALT_ROUNDS)
}

/**
 * Compare a plaintext password against a bcrypt hash
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function comparePassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash)
}
