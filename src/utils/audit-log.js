/**
 * Audit log emit helper — single entry point used by every mutating service
 * to write an immutable row to `audit_logs` (created in migration 043).
 *
 * Two emit modes:
 *   - `emit(action, payload)` — fire-and-forget. Wraps the INSERT in
 *     `setImmediate` and never awaits, so request latency is unaffected.
 *     Used for security events that have no surrounding mutation
 *     (login_success, login_failure, permission_denied,
 *     cross_shop_access_blocked, invalid_permission_string_detected) per
 *     design §12.2.
 *   - `emitInTx(client, action, payload)` — transactional. Reuses the
 *     caller's pg client (inside `BEGIN`...`COMMIT`) so the audit row
 *     commits atomically with the underlying mutation. Errors are
 *     re-thrown so the caller's transaction rolls back if the audit
 *     insert fails. Used by every mutating service path per design §12.2.
 *
 * Sensitive-field stripping (R28 AC#5): both modes deep-clone `before`
 * and `after` and remove the keys `password_hash`,
 * `force_password_change_token`, and `bank_account_number` at every
 * nesting level before serialisation. The redaction is the
 * application-layer invariant called out in the audit_logs migration
 * comments (043) and design §10 / §12.2.
 *
 * Append-only contract (R28 AC#3, design §12.4): this module ONLY emits
 * INSERT statements against `audit_logs`. The DB role grants
 * (deploy-time) and the static-grep CI check (design §17 Property 7)
 * enforce that no UPDATE or DELETE ever touches the table.
 *
 * Requirements: R28.4, R28.5
 * Design:       §10, §12.2 of .kiro/specs/multi-vendor-system/design.md
 */

import { pool } from '../config/database.js'
import { logger } from '../config/logger.js'

/**
 * Field names whose values must never reach the `audit_logs` table.
 * Kept as a Set for O(1) lookup during recursive redaction.
 *
 * R28 AC#5: password_hash, force_password_change_token, and
 * bank_account_number are stripped from every before/after snapshot.
 */
const SENSITIVE_FIELDS = new Set([
  'password_hash',
  'force_password_change_token',
  'bank_account_number',
  // Razorpay dashboard-managed credentials (migration 132) — see
  // src/modules/razorpay-settings — must never reach the audit log even
  // encrypted, since the audit row is a permanent, broader-access record.
  'keySecret',
  'webhookSecret',
  'test_key_secret_encrypted',
  'test_webhook_secret_encrypted',
  'live_key_secret_encrypted',
  'live_webhook_secret_encrypted',
])

const INSERT_SQL = `
  INSERT INTO audit_logs (
    actor_user_id, actor_role, actor_shop_id,
    target_type, target_id, action,
    before, after,
    ip_address, user_agent
  ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
`

/**
 * Recursively deep-clone `value` while stripping any property whose key
 * is in {@link SENSITIVE_FIELDS}. Handles `null`, `undefined`, primitive
 * values, arrays, and plain object trees. Non-plain object instances
 * (Date, Buffer, Map, etc.) are passed through by reference — the
 * audit-log payloads serialised to JSONB are expected to be plain row
 * snapshots so this is the right behaviour.
 *
 * @param {unknown} value
 * @returns {unknown} a redacted deep clone
 */
export function redact(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      out[i] = redact(value[i])
    }
    return out
  }

  // Plain objects only — anything else (Date, Buffer, Map, etc.) passes
  // through unchanged so JSON.stringify can serialise it the usual way.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(key)) continue
    out[key] = redact(child)
  }
  return out
}

/**
 * Build the ten-tuple of parameter values for {@link INSERT_SQL} from a
 * caller-supplied payload, stripping sensitive fields from `before` /
 * `after` and serialising both to JSON strings (the SQL casts to
 * `jsonb`). Throws synchronously when required fields are missing so
 * callers see the bug at the call site rather than via a swallowed
 * background error.
 *
 * @param {string} action
 * @param {AuditPayload} payload
 * @returns {Array<unknown>} parameter values for the INSERT
 */
function buildParams(action, payload) {
  if (!action || typeof action !== 'string') {
    throw new Error('audit-log: `action` is required')
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('audit-log: `payload` is required')
  }
  if (!payload.target_type || typeof payload.target_type !== 'string') {
    throw new Error('audit-log: `payload.target_type` is required')
  }

  const {
    actor_user_id = null,
    actor_role = null,
    actor_shop_id = null,
    target_type,
    target_id = null,
    before = null,
    after = null,
    ip_address = null,
    user_agent = null,
  } = payload

  const beforeRedacted = before == null ? null : JSON.stringify(redact(before))
  const afterRedacted = after == null ? null : JSON.stringify(redact(after))

  return [
    actor_user_id,
    actor_role,
    actor_shop_id,
    target_type,
    target_id,
    action,
    beforeRedacted,
    afterRedacted,
    ip_address,
    user_agent,
  ]
}

/**
 * Fire-and-forget audit emit. Returns immediately; the INSERT is
 * scheduled on the next tick via `setImmediate`. Any DB error is
 * structured-logged via pino and swallowed so the request path is
 * never affected.
 *
 * Use this for security events with no surrounding mutation
 * (login_success, login_failure, permission_denied,
 * cross_shop_access_blocked, invalid_permission_string_detected) per
 * design §12.2.
 *
 * @param {string} action — the audit verb (e.g. `login_failure`)
 * @param {AuditPayload} payload
 * @returns {void}
 */
export function emit(action, payload) {
  // Validate + redact synchronously so caller bugs surface at the call
  // site instead of the background tick.
  const params = buildParams(action, payload)

  setImmediate(async () => {
    try {
      await pool.query(INSERT_SQL, params)
    } catch (err) {
      logger.error(
        {
          err,
          action,
          target_type: payload.target_type,
          target_id: payload.target_id ?? null,
        },
        'audit_logs insert failed (fire-and-forget)',
      )
    }
  })
}

/**
 * Transactional audit emit. Uses the caller-supplied pg client (inside
 * a `BEGIN`...`COMMIT` block) so the audit row commits atomically with
 * the surrounding mutation per R28 AC#6 and design §12.2. Errors are
 * awaited and re-thrown so the caller's transaction rolls back when
 * the audit insert fails.
 *
 * @param {import('pg').PoolClient} client — the same client used by
 *   the caller's transaction (must already be inside `BEGIN`).
 * @param {string} action — the audit verb (e.g. `shop_product_updated`)
 * @param {AuditPayload} payload
 * @returns {Promise<void>}
 */
export async function emitInTx(client, action, payload) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('audit-log: `client` (pg PoolClient) is required for emitInTx')
  }
  const params = buildParams(action, payload)
  await client.query(INSERT_SQL, params)
}

/**
 * @typedef {object} AuditPayload
 * @property {string|null} [actor_user_id]   — UUID; null for unauthenticated events
 * @property {string|null} [actor_role]      — HQ_Role or Shop_Role snapshot string
 * @property {string|null} [actor_shop_id]   — UUID; null for HQ-scoped or unauth events
 * @property {string}       target_type      — REQUIRED (e.g. `user`, `shop_product`)
 * @property {string|null} [target_id]       — UUID; null when the event has no target row
 * @property {object|null} [before]          — pre-mutation snapshot (redacted before write)
 * @property {object|null} [after]           — post-mutation snapshot (redacted before write)
 * @property {string|null} [ip_address]      — request source IP; null for background jobs
 * @property {string|null} [user_agent]      — request user-agent; null for background jobs
 */
