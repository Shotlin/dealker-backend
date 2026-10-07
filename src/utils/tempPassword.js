import crypto from 'node:crypto'

const TEMP_PASSWORD_LENGTH = 12

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGIT = '0123456789'
// Symbols deliberately exclude characters that look like quotes / are
// shell-meta (", ', `, \) so operators can paste the password into a
// terminal without escaping.
const SYMBOL = '!@#$%^&*()-_=+'
const ALPHABET = LOWER + UPPER + DIGIT + SYMBOL

/**
 * Generate a 12-char cryptographically random temporary password with
 * mixed case, a digit, and a symbol guaranteed (one from each class,
 * then Fisher–Yates shuffled so they don't always land at the start).
 *
 * Caller MUST hash it via bcrypt before persisting and MUST return the
 * plaintext to the client exactly once — never log it.
 *
 * @returns {string} 12-char temp password
 */
export function generateTempPassword() {
  const chars = [
    LOWER[crypto.randomInt(0, LOWER.length)],
    UPPER[crypto.randomInt(0, UPPER.length)],
    DIGIT[crypto.randomInt(0, DIGIT.length)],
    SYMBOL[crypto.randomInt(0, SYMBOL.length)],
  ]
  while (chars.length < TEMP_PASSWORD_LENGTH) {
    chars.push(ALPHABET[crypto.randomInt(0, ALPHABET.length)])
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
